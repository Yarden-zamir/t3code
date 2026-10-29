/**
 * Fork WebSocket handlers and hooks. `ws.ts` merges `layerForkWsRpc` next to its own handler
 * layer and calls the helpers below, so the upstream file keeps one line per hook.
 */
import {
  MachineMapRequestError,
  CommandId,
  FORK_WS_METHODS,
  ForkWsRpcGroup,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationV2ThreadLaunchInput,
  type ServerConfig,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
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
import * as KitshnGrants from "./kitshn/KitshnGrants.ts";
import * as ForkUpdates from "./ForkUpdates.ts";
import { isMachineSubject } from "./machineMap/machineAccess.ts";
import * as KitshnProvider from "./kitshn/KitshnProvider.ts";
import * as MachinePeers from "./machineMap/MachinePeers.ts";
import * as PreviewServerGroups from "./PreviewServerGroups.ts";
import * as TerminalThreadMove from "./TerminalThreadMove.ts";
import * as ForkWorktreeRecreate from "./ForkWorktreeRecreate.ts";
import * as WebPush from "./webPush/WebPush.ts";

/** The fork RPC tags, which the upstream handler object in `ws.ts` omits. */
export const FORK_WS_RPC_TAGS = Object.values(FORK_WS_METHODS);

// Reuse snapshots so older clients do not need a new config event type.
export const environmentLabelUpdates = <E>(
  loadConfig: Effect.Effect<ServerConfig, E>,
  initialLabel: string,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const provider = yield* Effect.serviceOption(KitshnProvider.KitshnProvider);
      if (Option.isNone(provider)) return Stream.empty;
      const settings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* ServerEnvironment.ServerEnvironment;
      // Each `register` answer can bring a new machine name; the label reads it again.
      const changes = Stream.merge(
        provider.value.state.pipe(Stream.map(() => "kitshn")),
        settings.streamChanges.pipe(
          Stream.map((value) => String(value.environmentLabelFromMachineMap)),
          Stream.changes,
        ),
      ).pipe(
        Stream.mapEffect(() => environment.getDescriptor.pipe(Effect.map((value) => value.label))),
      );
      return Stream.concat(Stream.make(initialLabel), changes).pipe(
        Stream.changes,
        Stream.drop(1),
        Stream.mapEffect(() => loadConfig),
        Stream.map((config) => ({ version: 1 as const, type: "snapshot" as const, config })),
      );
    }),
  );

// A handler layer of its own: one handler object for every RPC is too deep a type for tsc.
export const layerForkWsRpc = (currentSession: EnvironmentAuth.AuthenticatedSession) =>
  ForkWsRpcGroup.toLayer(
    Effect.gen(function* () {
      const forkChangelog = yield* ForkChangelog.ForkChangelog;
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
      // The portal is gone; these RPCs stay until the clients stop calling them.
      const replaced = new MachineMapRequestError({
        reason: "join-refused",
        detail: "The machine map is replaced by kitshn. Join with kitshn join on the machine.",
      });
      return ForkWsRpcGroup.of({
        [FORK_WS_METHODS.forkChangelogListReleases]: (_input) => forkChangelog.listReleases,
        [FORK_WS_METHODS.forkChangelogReleaseChanges]: (input) =>
          forkChangelog.releaseChanges(input),
        [FORK_WS_METHODS.forkChangelogUpstreamPending]: (_input) => forkChangelog.upstreamPending,
        [FORK_WS_METHODS.forkChangelogSyncStatus]: (_input) => forkChangelog.syncStatus,
        [FORK_WS_METHODS.forkChangelogStartSync]: (_input) => forkChangelog.startSync,
        [FORK_WS_METHODS.machineMapSubscribe]: (_input) => Stream.empty,
        [FORK_WS_METHODS.machineMapJoin]: (_input) => Effect.fail(replaced),
        [FORK_WS_METHODS.machineMapLeave]: (_input) => Effect.fail(replaced),
        [FORK_WS_METHODS.machineMapReportDesktop]: (_input) => Effect.succeed({}),
        [FORK_WS_METHODS.machineMapShareSettings]: (_input) => Effect.fail(replaced),
        [FORK_WS_METHODS.machineMapRead]: (_input) =>
          Effect.succeed({
            _tag: "unavailable" as const,
            reason: "off" as const,
            detail: "The machine map is replaced by kitshn. The kitshn map shows the machines.",
          }),
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

/** MM-1311: linked machines join the explicit list of trusted browser origins (K-1609). */
export const trustedBrowserOriginsConfig = (configured: ReadonlyArray<string> | undefined) =>
  Effect.serviceOption(KitshnGrants.KitshnGrants).pipe(
    Effect.map((grants) => {
      const origins = [
        ...new Set([
          ...(configured ?? []),
          ...(Option.isSome(grants) ? grants.value.peerOrigins() : []),
        ]),
      ];
      return origins.length === 0 ? {} : { trustedBrowserOrigins: origins };
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
 * K-706: a socket that a kitshn grant opened closes when the grant no longer covers its session:
 * a new table, an `endsAt` or the 24-hour limit. The upgrade then refuses it.
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
            Effect.flatMap((visitor) =>
              visitor === null
                ? Effect.never
                : grants.value.awaitLoss(grants.value.allowsSession(visitor, session)),
            ),
            Effect.as(HttpServerResponse.empty()),
          ),
    ),
  );
