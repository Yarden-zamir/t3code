/**
 * Fork WebSocket handlers and hooks. `ws.ts` merges `layerForkWsRpc` next to its own handler
 * layer and calls the helpers below, so the upstream file keeps one line per hook.
 */
import {
  CommandId,
  FORK_WS_METHODS,
  ForkWsRpcGroup,
  MachineMapRequestError,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationV2ThreadLaunchInput,
  type ServerConfig,
  ServerSettingsError,
  type ServerSettings as ServerSettingsValue,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpServerResponse } from "effect/http";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ForkChangelog from "./ForkChangelog.ts";
import { sessionAllowed } from "./kitshn/kitshnGrantRules.ts";
import { kitshnMachineRef } from "./kitshn/environmentLabel.ts";
import * as KitshnGrants from "./kitshn/KitshnGrants.ts";
import * as ForkUpdates from "./ForkUpdates.ts";
import { isMachineSubject } from "./machineMap/machineAccess.ts";
import * as KitshnSettingsSync from "./kitshn/KitshnSettingsSync.ts";
import * as MachinePeers from "./machineMap/MachinePeers.ts";
import * as PreviewServerGroups from "./PreviewServerGroups.ts";
import * as TerminalThreadMove from "./TerminalThreadMove.ts";
import * as ForkWorktreeRecreate from "./ForkWorktreeRecreate.ts";
import * as WebPush from "./webPush/WebPush.ts";

/** The fork RPC tags, which the upstream handler object in `ws.ts` omits. */
export const FORK_WS_RPC_TAGS = Object.values(FORK_WS_METHODS);

/**
 * The kitshn machine for the server config, only while this server run registered with kitshn.
 * The config needs a session, so the public descriptor never names the machine.
 */
export const kitshnMachineConfig = Effect.serviceOption(KitshnGrants.KitshnGrants).pipe(
  Effect.flatMap((grants) =>
    Option.isNone(grants)
      ? Effect.succeed(null)
      : grants.value.joinedMachine.pipe(Stream.runHead, Effect.map(Option.getOrNull)),
  ),
  Effect.map((machine) => {
    const ref = machine === null ? null : kitshnMachineRef(machine);
    return ref === null ? {} : { kitshnMachine: ref };
  }),
);

/** MM-1311: the origins of the machines that kitshn links, which trust this page (K-1609). */
export const trustedBrowserOriginsConfig = Effect.serviceOption(KitshnGrants.KitshnGrants).pipe(
  Effect.map((grants) => {
    const origins = Option.isSome(grants) ? grants.value.peerOrigins() : [];
    return origins.length === 0 ? {} : { trustedBrowserOrigins: origins };
  }),
);

const kitshnConfigKey = (
  value: Pick<ServerConfig, "environment" | "kitshnMachine" | "trustedBrowserOrigins">,
) =>
  JSON.stringify([
    value.environment.label,
    value.kitshnMachine?.id ?? null,
    value.kitshnMachine?.name ?? null,
    value.trustedBrowserOrigins ?? [],
  ]);

// Reuse snapshots so older clients do not need a new config event type.
export const environmentLabelUpdates = <C, E>(
  loadConfig: Effect.Effect<C, E>,
  initial: Parameters<typeof kitshnConfigKey>[0],
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const grants = yield* Effect.serviceOption(KitshnGrants.KitshnGrants);
      if (Option.isNone(grants)) return Stream.empty;
      const settings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* ServerEnvironment.ServerEnvironment;
      // A `register` answer or a reach event can change the machine or the peer origins.
      const changes = Stream.merge(
        Stream.merge(grants.value.joinedMachine, grants.value.peerOriginChanges),
        settings.streamChanges.pipe(
          Stream.map((value) => String(value.environmentLabelFromMachineMap)),
          Stream.changes,
        ),
      ).pipe(
        Stream.mapEffect(() =>
          Effect.all({
            environment: environment.getDescriptor,
            machine: kitshnMachineConfig,
            origins: trustedBrowserOriginsConfig,
          }).pipe(
            Effect.map(({ environment, machine, origins }) =>
              kitshnConfigKey({ environment, ...machine, ...origins }),
            ),
          ),
        ),
      );
      return Stream.concat(Stream.make(kitshnConfigKey(initial)), changes).pipe(
        Stream.changes,
        Stream.drop(1),
        Stream.mapEffect(() => loadConfig),
        Stream.map((config) => ({ version: 1 as const, type: "snapshot" as const, config })),
      );
    }),
  );

/** The settings session of one socket, from its kitshn visitor (K-721 `check`). */
export const kitshnSettingsSessionLayer = (request: HttpServerRequest.HttpServerRequest) =>
  Layer.effect(
    KitshnSettingsSync.KitshnSettingsSession,
    Effect.serviceOption(KitshnGrants.KitshnGrants).pipe(
      Effect.flatMap((grants) =>
        Option.isNone(grants) ? Effect.succeed(null) : grants.value.visitor(request),
      ),
      Effect.map((result) =>
        result?._tag === "visitor"
          ? KitshnSettingsSync.settingsSessionOf(result.visitor)
          : KitshnSettingsSync.OWNER_SESSION,
      ),
    ),
  );

/**
 * The server settings as the socket's session reads and writes them: the chain Project, Circle,
 * Environment, Shared, Default, where `ws.ts` sends the Circle layer. Read at layer build, so a
 * handler keeps the session of its socket.
 */
export const sessionSettingsView = Effect.gen(function* () {
  const session = yield* KitshnSettingsSync.KitshnSettingsSession;
  const sync = yield* Effect.serviceOption(KitshnSettingsSync.KitshnSettingsSync);
  if (Option.isNone(sync) || session.circles.length === 0) {
    return {
      serverSettings: (settings: ServerSettingsValue) => Effect.succeed(settings),
      settingsChanges: <E, R>(
        _snapshot: ServerSettingsValue,
        changes: Stream.Stream<ServerSettingsValue, E, R>,
      ) => changes,
      writePatch: (patch: ServerSettingsPatch) =>
        Effect.succeed(patch) as Effect.Effect<ServerSettingsPatch, ServerSettingsError>,
    };
  }
  // The saved settings that the socket's snapshot was made from; `settingsChanges` starts there.
  let lastSaved: ServerSettingsValue | null = null;
  return {
    serverSettings: (settings: ServerSettingsValue) => {
      lastSaved = settings;
      return sync.value.sessionServerSettings(session, settings);
    },
    settingsChanges: <E, R>(
      snapshot: ServerSettingsValue,
      changes: Stream.Stream<ServerSettingsValue, E, R>,
    ) =>
      sync.value.sessionSettingsChanges(
        session,
        { saved: lastSaved ?? snapshot, snapshot },
        changes,
      ),
    writePatch: (patch: ServerSettingsPatch) =>
      sync.value.writeSessionServerPatch(session, patch).pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath: "kitshn t3.settings circle part",
              operation: "write-file",
              cause,
            }),
        ),
      ),
  };
});

// A handler layer of its own: one handler object for every RPC is too deep a type for tsc.
export const layerForkWsRpc = (currentSession: EnvironmentAuth.AuthenticatedSession) =>
  ForkWsRpcGroup.toLayer(
    Effect.gen(function* () {
      const forkChangelog = yield* ForkChangelog.ForkChangelog;
      const settingsSync = yield* KitshnSettingsSync.KitshnSettingsSync;
      const settingsSession = yield* KitshnSettingsSync.KitshnSettingsSession;
      // The server provides it; a bare RPC layer, as in tests, reads only this environment.
      const machinePeers = yield* Effect.serviceOption(MachinePeers.MachinePeers);
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const webPush = yield* WebPush.WebPush;
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const previewServerGroups = yield* PreviewServerGroups.PreviewServerGroups;
      const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
      const terminalThreadMove = yield* TerminalThreadMove.TerminalThreadMove;
      const forkUpdates = yield* ForkUpdates.ForkUpdates;
      const worktreeRecreate = yield* ForkWorktreeRecreate.ForkWorktreeRecreate;
      /** MM-1907: this environment first, then the machines that its agents read. */
      const readableEnvironments = Effect.fn("ForkWs.readableEnvironments")(function* () {
        const self = yield* environment.getDescriptor;
        // Another machine uses its own arrows, so it does not learn the arrows of this one.
        const peers =
          Option.isNone(machinePeers) || isMachineSubject(currentSession.subject)
            ? []
            : yield* machinePeers.value.readableEnvironments;
        return [
          { environmentId: self.environmentId, name: self.label },
          ...peers.map(({ environmentId, name }) => ({ environmentId, name })),
        ];
      });
      return ForkWsRpcGroup.of({
        [FORK_WS_METHODS.forkChangelogListReleases]: (_input) => forkChangelog.listReleases,
        [FORK_WS_METHODS.forkChangelogReleaseChanges]: (input) =>
          forkChangelog.releaseChanges(input),
        [FORK_WS_METHODS.forkChangelogUpstreamPending]: (_input) => forkChangelog.upstreamPending,
        [FORK_WS_METHODS.forkChangelogSyncStatus]: (_input) => forkChangelog.syncStatus,
        [FORK_WS_METHODS.forkChangelogStartSync]: (_input) => forkChangelog.startSync,
        [FORK_WS_METHODS.machineMapSubscribe]: (_input) =>
          settingsSync.clientState(settingsSession),
        [FORK_WS_METHODS.machineMapShareSettings]: (input) =>
          settingsSync.share(input, settingsSession),
        [FORK_WS_METHODS.machineMapSetCircleSettings]: (input) =>
          settingsSync.setCircle(input, settingsSession).pipe(
            Effect.as({}),
            Effect.mapError(
              (error) =>
                new MachineMapRequestError({ reason: "settings-failed", detail: error.message }),
            ),
          ),
        [FORK_WS_METHODS.machineMapReadableEnvironments]: (_input) => readableEnvironments(),
        [FORK_WS_METHODS.webPushPublicKey]: (_input) =>
          webPush.publicKey.pipe(Effect.map((publicKey) => ({ publicKey }))),
        [FORK_WS_METHODS.webPushSubscribe]: (input) => webPush.subscribe(input).pipe(Effect.as({})),
        [FORK_WS_METHODS.webPushTest]: (input) => webPush.test(input.endpoint),
        // The scanner polls only while retained, as for `subscribeDiscoveredLocalServers`.
        [FORK_WS_METHODS.forkPreviewSubscribeLocalListeners]: (_input) =>
          Stream.unwrap(portDiscovery.retain.pipe(Effect.as(previewServerGroups.listeners))),
        [FORK_WS_METHODS.vcsPrepareDraftWorktree]: (input) =>
          threadLaunch.prepareDraftWorktree(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2ThreadLaunchError({
                  commandId: CommandId.make(`fork-draft-worktree:${input.threadId}`),
                  projectId: input.projectId,
                  message: ThreadLaunchService.failureDetail(cause),
                  cause,
                }),
            ),
          ),
        [FORK_WS_METHODS.terminalMoveToThread]: (input) =>
          terminalThreadMove.moveToThread(input).pipe(Effect.as({})),
        [FORK_WS_METHODS.forkUpdatesTerminalHold]: (input) =>
          forkUpdates.terminalHold(input.heldSince),
        [FORK_WS_METHODS.threadRecreateWorktree]: (input) => worktreeRecreate.recreate(input),
      });
    }),
  );

/**
 * A launch is accepted before its worktree exists, so a branch that cannot be created is refused
 * while the client can still act.
 */
export const checkLaunchWorktreeBranch = (
  threadLaunch: ThreadLaunchService.ThreadLaunchService["Service"],
  input: OrchestrationV2ThreadLaunchInput,
) =>
  input.workspaceStrategy.type === "worktree" &&
  input.workspaceStrategy.branch !== undefined &&
  !isTemporaryWorktreeBranch(input.workspaceStrategy.branch)
    ? threadLaunch
        .checkWorktreeBase({
          projectId: input.projectId,
          workspaceStrategy: input.workspaceStrategy,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2ThreadLaunchError({
                commandId: input.commandId,
                projectId: input.projectId,
                message: cause.message,
                cause,
              }),
          ),
        )
    : Effect.void;

/**
 * K-721: a socket that a kitshn visitor opened closes when its level no longer covers the session:
 * after a re-check on `grants-changed`, or at its `until`. The upgrade then checks it again.
 */
export const awaitKitshnLoss = (
  request: HttpServerRequest.HttpServerRequest,
  session: Pick<EnvironmentAuth.AuthenticatedSession, "sessionId" | "subject" | "scopes">,
) =>
  Effect.serviceOption(KitshnGrants.KitshnGrants).pipe(
    Effect.flatMap((grants) =>
      Option.isNone(grants)
        ? Effect.never
        : grants.value.visitor(request).pipe(
            Effect.flatMap((result) =>
              result._tag === "visitor"
                ? grants.value.awaitLoss(result.visitor, (latest) =>
                    sessionAllowed(session, latest.levels),
                  )
                : Effect.never,
            ),
            Effect.as(HttpServerResponse.empty()),
          ),
    ),
  );
