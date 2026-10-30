/**
 * Fork: the T3 server as a kitshn provider (kitshn K-704 to K-707), the only way this server joins
 * other machines. The server runs `kitshn provider` of the machine's kitshn 2 and registers its
 * cards and commands. A missing kitshn, a refusal or an exit only logs, and the server tries again
 * later; without kitshn 2 the server behaves as upstream (K-712). Its grant tables go to `KitshnGrants`, which enforces them.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A row id needs a synchronous hash inside a pure list builder.
import * as NodeCrypto from "node:crypto";

import type { MachineCommandInput, MachineStatus } from "@t3tools/contracts";
import { THREAD_CREDENTIAL_AUTHORIZATION_ENV } from "@t3tools/provider-core/server/forkThreadCredential";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ForkUpdates from "../ForkUpdates.ts";
import * as MachineHost from "../machineMap/MachineHost.ts";
import { redactSecretsInText } from "../redactUrlSecrets.ts";
import { makeListSharedThreads, type SharedThread } from "./sharedThreads.ts";
import { kitshnOwnerRefusal } from "./KitshnAttester.ts";
import * as KitshnCli from "./KitshnCli.ts";
import {
  AGENTS_RESOURCE_ID,
  APP_RESOURCE_ID,
  KINDS,
  peerOriginsOf,
  threadResourceId,
} from "./kitshnGrantRules.ts";
import * as KitshnGrants from "./KitshnGrants.ts";
import {
  type Answer,
  grantCount,
  MAX_COMMAND_OUTPUT_LENGTH,
  PROVIDER_NAME,
  type ProviderCommand,
  type ProviderList,
  type ProviderClientApp,
  type ProviderResource,
  ProviderResource as ProviderResourceSchema,
  type AccessApp,
  type AskResult,
  type CardSettingValues,
  type DesiredParts,
  type LocalRequest,
  type ReachedCard,
  type LocalRequestInput,
  type Request,
  ROW_ID_LIMIT,
  decodeAnswer,
  requestLine,
} from "./kitshnProviderProtocol.ts";

// After a connection that registered: a daemon restart ends the child, and T3 comes back fast.
const RETRY_AFTER_REGISTER = Duration.seconds(1);
const RETRY_FIRST = Duration.seconds(5);
// After a daemon restart, a queued command waits 60 seconds for `register` (K-707).
const RETRY_CAP = Duration.seconds(30);
// Known limit: the busy count and the thread cards are polled, so a card can lag by this much.
// Revisit if kitshn starts "when idle" jobs (K-1608) that need a faster busy fact. A thread card
// that lags grants nothing: the guest routes check the share itself on each request.
const FACTS_POLL = Duration.seconds(15);
// K-706: only kitshn's own answers keep the saved table fresh. The daemon forwards a `grants`
// event only on a change, so this ask proves contact with kitshn while nothing changes.
const CONTACT_PROBE = Duration.hours(1);
// kitshn holds 500 cards per machine for all providers (K-704).
const THREAD_CARDS_LIMIT = 200;
// Below the daemon's 5-minute limit, so T3 answers before the daemon gives up.
const COMMAND_TIMEOUT = Duration.minutes(4.5);
// Time for the result line to reach the daemon before the process ends.
const RESTART_FLUSH = Duration.millis(500);
const STDERR_KEEP = 4096;
// The daemon answers local requests itself, except an ask, which waits up to 60 seconds for kitshn.
const LOCAL_REQUEST_TIMEOUT = Duration.seconds(35);
const ASK_TIMEOUT = Duration.seconds(65);
// A child that stopped answering (its daemon went away) is ended at the next `samples` probe that
// gets no answer. Known limit: that takes up to this interval plus LOCAL_REQUEST_TIMEOUT. Revisit
// if local requests need a faster recovery.
const LIVENESS_PROBE = Duration.minutes(3);
// The daemon answers `register` itself; a child without that answer is stuck like one above.
const REGISTER_TIMEOUT = Duration.seconds(35);

const resourceKey = Schema.encodeSync(Schema.fromJsonString(ProviderResourceSchema));

/** A thread card: only threads with an open guest share (K-704), stacked under the app card. */
const threadCard = (thread: SharedThread): ProviderResource => ({
  id: threadResourceId(thread.threadId),
  kind: "t3.thread",
  name: (thread.title.trim() === "" ? "Untitled thread" : thread.title).slice(0, 80),
  status: "running",
  parent: APP_RESOURCE_ID,
  stickers: [
    {
      text: "Open thread",
      tone: "info",
      link: `https://${thread.host}/guest?share=${encodeURIComponent(thread.shareId)}`,
    },
  ],
});

/** The kitshn commands, each the machine map command of the same name (MachineHost). */
const COMMANDS = [
  {
    id: "restart-server",
    title: "Restart server",
    confirm: true,
    input: { _tag: "restartServer" },
  },
  {
    id: "install-update",
    title: "Install update when idle",
    confirm: true,
    input: { _tag: "installUpdate", whenIdle: true },
  },
  {
    id: "stop-all-agents",
    title: "Stop all agents",
    confirm: true,
    input: { _tag: "stopAllAgents" },
  },
  {
    id: "pause-scheduled-tasks",
    title: "Pause scheduled tasks",
    confirm: true,
    input: { _tag: "pauseScheduledTasks" },
  },
  {
    id: "collect-diagnostics",
    title: "Collect diagnostics",
    confirm: false,
    input: { _tag: "collectDiagnostics" },
  },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly confirm: boolean;
  readonly input: MachineCommandInput;
}>;
type KitshnCommand = (typeof COMMANDS)[number];

/** K-1625: a list holds at most this many rows. Revisit when an owner has more tasks or clients. */
const LIST_ROWS_LIMIT = 100;
const CELL_LIMIT = 200;
const TASK_ROW = "task:";
const SESSION_ROW = "session:";

/** kitshn refuses the whole registration when a row id is longer than ROW_ID_LIMIT. */
const rowIdOf = (prefix: string, id: string) => {
  const plain = `${prefix}${id}`;
  if (plain.length <= ROW_ID_LIMIT) return plain;
  const hash = NodeCrypto.createHash("sha256").update(id).digest("hex");
  return `${prefix}${hash.slice(0, ROW_ID_LIMIT - prefix.length)}`;
};

/** K-1625: the row commands of the T3 card. Each one turns its row into a machine map command. */
const ROW_COMMANDS = [
  {
    id: "run-task",
    title: "Run now",
    confirm: true,
    row: TASK_ROW,
    input: (taskId: string): MachineCommandInput => ({ _tag: "runScheduledTask", taskId }),
  },
  {
    id: "pause-task",
    title: "Pause",
    confirm: false,
    row: TASK_ROW,
    input: (taskId: string): MachineCommandInput => ({
      _tag: "setScheduledTaskEnabled",
      taskId,
      enabled: false,
    }),
  },
  {
    id: "resume-task",
    title: "Resume",
    confirm: false,
    row: TASK_ROW,
    input: (taskId: string): MachineCommandInput => ({
      _tag: "setScheduledTaskEnabled",
      taskId,
      enabled: true,
    }),
  },
  {
    id: "revoke-session",
    title: "Revoke session",
    confirm: true,
    row: SESSION_ROW,
    input: (sessionId: string): MachineCommandInput => ({ _tag: "revokeClient", sessionId }),
  },
] as const;

/** The machine map command of a row command, or undefined when the row is not of its list. */
const rowCommandInput = (
  command: string,
  row: string,
  status: Pick<MachineStatus, "tasks" | "clients">,
) => {
  const entry = ROW_COMMANDS.find((candidate) => candidate.id === command);
  if (entry === undefined) return undefined;
  const ids =
    entry.row === TASK_ROW
      ? (status.tasks ?? []).map((task) => task.id)
      : status.clients.map((session) => session.sessionId);
  const id = ids.find((candidate) => rowIdOf(entry.row, candidate) === row);
  return id === undefined ? undefined : entry.input(id);
};

const cell = (value: string) => value.slice(0, CELL_LIMIT);

/** K-1625: the scheduled tasks and client sessions of this server, as lists of the T3 card. */
const appLists = (
  status: Pick<MachineStatus, "tasks" | "clients">,
): ReadonlyArray<ProviderList> => [
  {
    id: "tasks",
    title: "Scheduled tasks",
    columns: [
      { id: "title", title: "Task" },
      { id: "schedule", title: "Schedule" },
      { id: "state", title: "State" },
      { id: "next", title: "Next run" },
    ],
    rows: (status.tasks ?? []).slice(0, LIST_ROWS_LIMIT).map((task) => ({
      id: rowIdOf(TASK_ROW, task.id),
      cells: {
        title: cell(task.title),
        schedule: cell(task.schedule),
        state: task.enabled ? "on" : "paused",
        next: task.nextRunAt ?? "",
      },
      commands: ["run-task", task.enabled ? "pause-task" : "resume-task"],
    })),
  },
  {
    id: "sessions",
    title: "Client sessions",
    columns: [
      { id: "client", title: "Client" },
      { id: "device", title: "Device" },
      { id: "connected", title: "Connected" },
      { id: "lastSeen", title: "Last seen" },
    ],
    rows: status.clients.slice(0, LIST_ROWS_LIMIT).map((session) => ({
      id: rowIdOf(SESSION_ROW, session.sessionId),
      cells: {
        client: cell(session.label ?? session.browser ?? session.subject),
        device: cell([session.deviceType, session.os].filter((part) => part !== null).join(", ")),
        connected: session.connected ? "yes" : "no",
        lastSeen: session.lastSeenAt ?? "",
      },
      commands: ["revoke-session"],
    })),
  },
];

const CUT_NOTE = "\n[cut at 64 KiB]";
// MachineHost redacts the diagnostics at the source, which the machine map portal shares.
const commandOutput = (outcome: MachineHost.CommandOutcome) => {
  const text = outcome.ok
    ? JSON.stringify(outcome.result ?? null, null, 2)
    : redactSecretsInText(outcome.error ?? "The command failed.");
  return text.length <= MAX_COMMAND_OUTPUT_LENGTH
    ? text
    : text.slice(0, MAX_COMMAND_OUTPUT_LENGTH - CUT_NOTE.length) + CUT_NOTE;
};

class RegisterRefused extends Schema.TaggedError<RegisterRefused>()("RegisterRefused", {
  error: Schema.String,
}) {}

/** K-709: the desired state kind of the T3 settings, in the `ForkSettingsState` shape. */
export const SETTINGS_KIND = "t3.settings";
/** K-717: the update channel of the app card. */
const UPDATE_CHANNEL_SETTING = "updateChannel";

const OBTAINIUM_FORK_APP =
  "https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22com.yardenzamir.t3code%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2FYarden-zamir%2Ft3code%22%2C%22author%22%3A%22Yarden-zamir%22%2C%22name%22%3A%22T3%20Code%20fork%22%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Atrue%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22android%5C%5C%5C%5C.apk%24%5C%22%7D%22%7D";

/**
 * The apps that open a kitshn device invite; they fill Settings > Connections > New with it.
 * The store app has no `inviteUrl` deep link, so only the fork app is listed.
 */
const CLIENT_APPS: ReadonlyArray<ProviderClientApp> = [
  {
    id: "t3code-fork",
    name: "T3 Code (fork)",
    open: "t3code-preview://connections/new?inviteUrl={inviteUrl}",
    install: [{ label: "Install with Obtainium", url: OBTAINIUM_FORK_APP }],
  },
];

const REGISTERED_KINDS = [
  ...KINDS.map((kind) =>
    kind.id === "t3.app"
      ? {
          ...kind,
          settings: [
            {
              id: UPDATE_CHANNEL_SETTING,
              title: "Update channel",
              values: ["nightly", "daily"],
              default: "nightly",
            },
          ],
        }
      : kind,
  ),
  { id: SETTINGS_KIND, name: "T3 settings", levels: {}, state: {} },
];

/** K-1611: the connection of this provider to the kitshn daemon, for Settings and agents. */
export type KitshnConnection =
  | { readonly status: "off"; readonly detail: string }
  | { readonly status: "connecting"; readonly detail: string | null }
  /**
   * `detail` and `restartedAt` (epoch ms): set only when T3 ended the connection before this one
   * because it was stuck.
   */
  | {
      readonly status: "registered";
      readonly detail: string | null;
      readonly restartedAt: number | null;
    };

/** What kitshn keeps for this provider besides grants: the settings state and card settings. */
export interface KitshnProviderState {
  readonly settings: DesiredParts | null;
  readonly cardSettings: CardSettingValues;
  /** K-1609: the cards of other machines that this machine reaches. */
  readonly reach: ReadonlyArray<ReachedCard>;
}

/** K-1623: the label of the machine's portal tunnel host, which kitshn takes over by handover. */
const portalSiteName = (tunnelPairingUrl: string | undefined) => {
  if (tunnelPairingUrl === undefined) return undefined;
  const label = new URL(tunnelPairingUrl).hostname.split(".", 1)[0] ?? "";
  return label.startsWith("t3-") ? label : undefined;
};

/**
 * K-705: the card's site and the real port. Without a portal host it is `t3-<kitshn machine name>`,
 * so kitshn gives a new machine its address; without a site the link proxy refuses every link.
 */
export const appSite = (
  config: { readonly tunnelPairingUrl?: string | undefined; readonly port: number },
  machineName: string | null,
) => {
  const slug = (machineName ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((part) => part.length > 0)
    .join("-")
    .slice(0, 60)
    .replace(/-+$/u, "");
  const name = portalSiteName(config.tunnelPairingUrl) ?? (slug === "" ? undefined : `t3-${slug}`);
  return name === undefined ? undefined : { name, port: config.port };
};

/** Why a local request to kitshn did not get an answer. */
export class KitshnRequestError extends Schema.TaggedError<KitshnRequestError>()(
  "KitshnRequestError",
  { message: Schema.String },
) {}

export class KitshnProvider extends Context.Service<
  KitshnProvider,
  {
    /** Connects to kitshn for the life of the server, and again after each exit. Never fails. */
    readonly run: Effect.Effect<void>;
    /**
     * One ask or local request over the live connection, and its answer. An `error` answer
     * fails with its text, as does a server without a registered connection.
     */
    /** The last settings state and card settings from kitshn, then each change. */
    readonly state: Stream.Stream<KitshnProviderState>;
    /**
     * K-1609: the link proxy of the live connection, after `kitshn link-check` passed, or null.
     * It is gone the moment that connection closes, so no call goes to an old path.
     */
    readonly linkSocket: Effect.Effect<string | null>;
    /**
     * K-1623: true while this machine's T3 host is not with kitshn: the card names its site, and
     * kitshn has not named the Access app of the host.
     */
    readonly hostNotice: Stream.Stream<boolean>;
    /** K-1623: the hosts whose DNS record points at kitshn's tunnel (`access.served`). */
    readonly servedHosts: Stream.Stream<ReadonlyArray<string>>;
    /** K-1611: the connection now, then each change. */
    readonly connection: Stream.Stream<KitshnConnection>;
    /** K-1609: whether the daemon named a link proxy, and whether `kitshn link-check` passed. */
    readonly linkProxyState: Effect.Effect<"none" | "unchecked" | "checked">;
    /** K-1722: the answers to this machine's waiting asks, newest first, at most 50. */
    readonly askResults: Effect.Effect<ReadonlyArray<AskResult>>;
    /** A call on the link socket failed: the next use runs `kitshn link-check` again first. */
    readonly linkSocketFailed: (socket: string) => Effect.Effect<void>;
    readonly request: (
      request: LocalRequestInput,
    ) => Effect.Effect<Exclude<Answer, { readonly type: "error" }>, KitshnRequestError>;
  }
>()("t3/fork/kitshn/KitshnProvider") {}

export const make = Effect.fn("KitshnProvider.make")(function* (
  /** The threads with an open guest share, or none when the read failed. */
  listSharedThreads: Effect.Effect<Option.Option<ReadonlyArray<SharedThread>>>,
) {
  const cli = yield* KitshnCli.KitshnCli;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const host = yield* MachineHost.MachineHost;
  const forkUpdates = yield* ForkUpdates.ForkUpdates;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serviceScope = yield* Effect.scope;
  const ownerRefusal = yield* kitshnOwnerRefusal();
  const grants = yield* KitshnGrants.KitshnGrants;
  const providerState = yield* SubscriptionRef.make<KitshnProviderState>({
    settings: null,
    cardSettings: {},
    reach: [],
  });
  // K-1609: the one place that holds the link proxy, owned by the connection that registered it.
  const linkProxy = yield* Ref.make<{ readonly path: string; readonly checked: boolean } | null>(
    null,
  );
  const linkChecks = yield* Semaphore.make(1);
  const hostNotice = yield* SubscriptionRef.make(false);
  const servedHosts = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
  const askResults = yield* Ref.make<ReadonlyArray<AskResult>>([]);
  const connection = yield* SubscriptionRef.make<KitshnConnection>({
    status: "connecting",
    detail: null,
  });
  // Why T3 ended the last child itself, so the next registered connection can show it.
  const restartNote = yield* Ref.make<{ readonly reason: string; readonly at: number } | null>(
    null,
  );
  // The live registered connection, so `request` can use it.
  const live = yield* Ref.make<
    Option.Option<(request: LocalRequestInput) => Effect.Effect<Answer, KitshnRequestError>>
  >(Option.none());

  const registered: ReadonlyArray<KitshnCommand> = COMMANDS.filter((command) =>
    host.supportedCommands({ desktopConnected: false }).includes(command.input._tag),
  );
  const providerCommands: ReadonlyArray<ProviderCommand> = [...registered, ...ROW_COMMANDS].map(
    (command) => ({
      id: command.id,
      title: command.title,
      kinds: ["t3.app"],
      confirm: command.confirm,
    }),
  );

  const serverConfig = yield* ServerConfig.ServerConfig;
  const portalSite = portalSiteName(serverConfig.tunnelPairingUrl);
  /** K-1623: one log line when the host is not with kitshn; Settings > Machines shows it too. */
  const setHostNotice = Effect.fn("KitshnProvider.setHostNotice")(function* (
    access: AccessApp | null,
  ) {
    // Before the handover kitshn sends no access, or access with no audience (contract §10).
    const notWithKitshn =
      portalSite !== undefined && (access === null || access.audiences.length === 0);
    yield* SubscriptionRef.set(servedHosts, access?.served ?? []);
    const before = yield* SubscriptionRef.getAndSet(hostNotice, notWithKitshn);
    if (notWithKitshn && !before) {
      yield* Effect.logWarning(
        `This machine's host ${portalSite} is not with kitshn. Select Take the address on its T3 card in kitshn, then run scripts/fork-host-handover.ts <machine>.`,
      );
    }
  });
  const appStatus = host.status({
    desktopConnected: false,
    updateWaiting: null,
    desktopBuild: null,
  });
  const appResource = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    const status = yield* appStatus;
    const site = appSite(serverConfig, (yield* grants.machine)?.name ?? null);
    const busy = yield* threads.getShellSnapshot().pipe(
      Effect.map(
        (snapshot) => snapshot.threads.filter((thread) => thread.activeRunId !== null).length,
      ),
      Effect.option,
    );
    return {
      id: APP_RESOURCE_ID,
      kind: "t3.app",
      name: `T3 on ${descriptor.label}`.slice(0, 80),
      status: "running",
      ...(site === undefined ? {} : { site }),
      facts: [
        { label: "Version", value: descriptor.serverVersion, role: "version" },
        {
          label: "Running turns",
          value: Option.match(busy, { onNone: () => "unknown", onSome: String }),
        },
        // K-1608: "true" holds jobs sent "when idle"; T3 keeps its own idle check as well.
        {
          label: "Busy",
          value: Option.match(busy, {
            onNone: () => "false",
            onSome: (count) => String(count > 0),
          }),
          role: "busy",
        },
      ],
      lists: appLists(status),
    } satisfies ProviderResource;
  });

  const agentsResource = environment.getDescriptor.pipe(
    Effect.map((descriptor): ProviderResource => ({
      id: AGENTS_RESOURCE_ID,
      kind: "t3.agents",
      name: `Agents on ${descriptor.label}`.slice(0, 80),
      status: "running",
      parent: APP_RESOURCE_ID,
    })),
  );

  const threadCards = Effect.all([listSharedThreads, Clock.currentTimeMillis]).pipe(
    Effect.map(([threads, nowMs]) =>
      Option.map(threads, (all) =>
        all
          .filter((thread) => Date.parse(thread.expiresAt) > nowMs)
          .slice(0, THREAD_CARDS_LIMIT)
          .map(threadCard),
      ),
    ),
  );

  /** One `kitshn provider` child, until it exits. Returns why it ended and whether it registered. */
  const connectOnce = Effect.scoped(
    Effect.gen(function* () {
      const binary = yield* cli.binary;
      const child = yield* spawner.spawn(
        ChildProcess.make(binary, ["provider"], {
          // The server env can hold the credential of an agent shell that started it.
          env: { [THREAD_CREDENTIAL_AUTHORIZATION_ENV]: "" },
          extendEnv: true,
        }),
      );
      const outbox = yield* Queue.unbounded<string>();
      yield* Stream.fromQueue(outbox).pipe(
        Stream.encodeText,
        Stream.run(child.stdin),
        Effect.ignore,
        Effect.forkScoped,
      );
      const stderr = yield* child.stderr.pipe(
        Stream.decodeText,
        Stream.runFold(
          () => "",
          (kept, chunk) => (kept + chunk).slice(-STDERR_KEEP),
        ),
        Effect.orElseSucceed(() => ""),
        Effect.forkScoped,
      );
      let lastId = 0;
      // Ids are digits only, so none equals kitshn's reserved id `kitshn-provider-heartbeat`.
      const nextId = () => String(++lastId);
      const send = (request: Request) => Queue.offer(outbox, requestLine(request));
      const waiting = new Map<string, Deferred.Deferred<Answer>>();
      const connectionScope = yield* Effect.scope;
      const unanswered = yield* Deferred.make<string>();
      const awaitAnswer = Effect.fn("KitshnProvider.awaitAnswer")(function* (
        request: LocalRequestInput,
      ) {
        const id = nextId();
        const answer = yield* Deferred.make<Answer>();
        waiting.set(id, answer);
        yield* send({ ...request, id } as LocalRequest);
        return yield* Deferred.await(answer).pipe(
          Effect.timeoutOption(request.type === "ask" ? ASK_TIMEOUT : LOCAL_REQUEST_TIMEOUT),
          Effect.ensuring(Effect.sync(() => waiting.delete(id))),
        );
      });
      // The daemon answers `samples` itself, so no answer means that the child stopped answering.
      const checkAlive = awaitAnswer({ type: "samples" }).pipe(
        Effect.flatMap((received) =>
          Option.isSome(received)
            ? Effect.void
            : Deferred.succeed(
                unanswered,
                `the kitshn provider did not answer in ${Duration.format(LOCAL_REQUEST_TIMEOUT)}, so T3 ended it`,
              ),
        ),
        Effect.asVoid,
      );
      const localRequest = Effect.fn("KitshnProvider.localRequest")(function* (
        request: LocalRequestInput,
      ) {
        const received = yield* awaitAnswer(request);
        if (Option.isNone(received)) {
          // The daemon can hold an ask 60 seconds for kitshn, so only `samples` proves the child dead.
          yield* checkAlive.pipe(Effect.forkIn(connectionScope));
          return yield* new KitshnRequestError({ message: "kitshn did not answer in time." });
        }
        return received.value;
      });
      yield* Effect.addFinalizer(() => Ref.set(live, Option.none()));
      yield* Effect.addFinalizer(() => Ref.set(linkProxy, null));

      const registerId = nextId();
      const registeredOnce = yield* Deferred.make<void>();
      const app = yield* appResource;
      let sentApp = resourceKey(app);
      // K-704: register only with the full list; a card that it leaves out goes offline.
      let sentThreads = new Map(
        Option.getOrElse(yield* threadCards, () => []).map((card) => [card.id, card] as const),
      );
      yield* send({
        id: registerId,
        type: "register",
        provider: PROVIDER_NAME,
        kinds: REGISTERED_KINDS,
        commands: providerCommands,
        resources: [app, yield* agentsResource, ...sentThreads.values()],
        clients: CLIENT_APPS,
      });
      yield* Deferred.await(registeredOnce).pipe(
        Effect.timeoutOption(REGISTER_TIMEOUT),
        Effect.flatMap((answered) =>
          Option.isSome(answered)
            ? Effect.void
            : Deferred.succeed(
                unanswered,
                `kitshn did not answer register in ${Duration.format(REGISTER_TIMEOUT)}, so T3 ended it`,
              ),
        ),
        Effect.forkScoped,
      );

      const handleCommand = Effect.fn("KitshnProvider.handleCommand")(function* (
        event: Extract<Answer, { readonly type: "command" }>,
      ) {
        const input =
          event.row === undefined
            ? registered.find((entry) => entry.id === event.command)?.input
            : rowCommandInput(event.command, event.row, yield* appStatus);
        const outcome: MachineHost.CommandOutcome =
          input === undefined || event.resource !== APP_RESOURCE_ID
            ? {
                ok: false,
                result: null,
                error: `T3 has no command ${event.command} for ${event.row ?? event.resource ?? "the machine"}.`,
              }
            : yield* host.runInput(`kitshn:${event.commandId}`, input).pipe(
                Effect.timeoutOption(COMMAND_TIMEOUT),
                Effect.map(
                  Option.getOrElse((): MachineHost.CommandOutcome => ({
                    ok: false,
                    result: null,
                    error: `The command did not finish in ${Duration.format(COMMAND_TIMEOUT)}.`,
                  })),
                ),
              );
        yield* send({
          id: nextId(),
          type: "command-result",
          provider: PROVIDER_NAME,
          commandId: event.commandId,
          ok: outcome.ok,
          output: commandOutput(outcome),
        });
        // K-707: answer first, then restart. The service scope outlives this connection.
        if (outcome.restartAfterReply === true) {
          yield* Effect.sleep(RESTART_FLUSH).pipe(
            Effect.andThen(host.restartProcess),
            Effect.forkIn(serviceScope),
          );
        }
      });

      // Untraced: one span per stdout line would be noise.
      const handleLine = Effect.fnUntraced(function* (line: string) {
        if (line.trim() === "") return;
        const decoded = decodeAnswer(line);
        if (Option.isNone(decoded)) {
          // The line can hold e-mail addresses of grants, so only its length is logged.
          return yield* Effect.logWarning(
            `kitshn provider: skipped a line that is not a known answer or event (${line.length} characters)`,
          );
        }
        const answer = decoded.value;
        // Only kitshn's own answers prove contact. The daemon answers an ask `refused` by itself after
        // 60 seconds, and a `github-token` ask locally; T3 never sends `github-token`.
        if (
          answer.type === "grants" ||
          answer.type === "ask-result" ||
          (answer.type === "ask" && (answer.outcome === "done" || answer.outcome === "waiting"))
        ) {
          yield* grants.contact;
        }
        const asked = "id" in answer && answer.id !== null ? waiting.get(answer.id) : undefined;
        if (asked !== undefined) return yield* Deferred.succeed(asked, answer);
        switch (answer.type) {
          case "register":
            if (answer.id !== registerId) return;
            yield* grants.replaceTables(answer.grants);
            yield* grants.setMachine({ id: answer.machineId, name: answer.machineName ?? null });
            yield* SubscriptionRef.set(providerState, {
              settings: answer.desired?.[SETTINGS_KIND] ?? null,
              cardSettings: answer.settings ?? {},
              reach: answer.reach ?? [],
            });
            yield* grants.setPeerOrigins(peerOriginsOf(answer.reach ?? []));
            yield* Ref.update(linkProxy, (current) => {
              const path = answer.linkSocket ?? null;
              if (path === null) return null;
              return current?.path === path ? current : { path, checked: false };
            });
            yield* grants.setAccess(answer.access ?? null);
            yield* setHostNotice(answer.access ?? null);
            yield* Ref.set(live, Option.some(localRequest));
            const note = yield* Ref.get(restartNote);
            const registeredState: KitshnConnection = {
              status: "registered",
              detail: note?.reason ?? null,
              restartedAt: note?.at ?? null,
            };
            yield* SubscriptionRef.set(connection, registeredState);
            yield* Deferred.succeed(registeredOnce, undefined);
            return yield* Effect.logInfo(
              `kitshn provider: registered, with ${grantCount(answer.grants)} grants`,
            );
          case "desired":
            if (answer.kind !== SETTINGS_KIND) return;
            return yield* SubscriptionRef.update(providerState, (current) => ({
              ...current,
              settings: answer.state,
            }));
          case "settings":
            return yield* SubscriptionRef.update(providerState, (current) => ({
              ...current,
              cardSettings: answer.values,
            }));
          case "access":
            yield* setHostNotice(answer.access);
            return yield* grants.setAccess(answer.access);
          case "reach":
            yield* grants.setPeerOrigins(peerOriginsOf(answer.cards));
            return yield* SubscriptionRef.update(providerState, (current) => ({
              ...current,
              reach: answer.cards,
            }));
          case "grants":
            yield* grants.replaceTables(answer.tables);
            return yield* Effect.logInfo(
              `kitshn provider: ${grantCount(answer.tables)} grants from kitshn`,
            );
          case "command":
            return yield* handleCommand(answer).pipe(Effect.forkScoped, Effect.asVoid);
          case "error":
            if (answer.id === registerId) {
              return yield* new RegisterRefused({ error: answer.error });
            }
            return yield* Effect.logWarning(`kitshn provider: kitshn refused: ${answer.error}`);
          case "ask-result":
            return yield* Ref.update(askResults, (results) => [answer, ...results].slice(0, 50));
          case "upsert":
          case "remove":
          case "command-result":
          case "ask":
          case "job-cancel":
          case "samples":
          case "desired-set":
          case "audit":
            return;
        }
      });

      yield* Deferred.await(registeredOnce).pipe(
        Effect.andThen(
          localRequest({ type: "ask", action: "state", target: "" }).pipe(
            Effect.ignore,
            Effect.andThen(Effect.sleep(CONTACT_PROBE)),
            Effect.forever,
          ),
        ),
        Effect.forkScoped,
      );

      yield* Deferred.await(registeredOnce).pipe(
        Effect.andThen(
          Effect.sleep(LIVENESS_PROBE).pipe(Effect.andThen(checkAlive), Effect.forever),
        ),
        Effect.forkScoped,
      );

      const refreshCards = Effect.gen(function* () {
        const current = yield* appResource;
        const changed: Array<ProviderResource> = [];
        if (resourceKey(current) !== sentApp) {
          sentApp = resourceKey(current);
          changed.push(current);
        }
        const cards = yield* threadCards;
        if (Option.isSome(cards)) {
          const next = new Map(cards.value.map((card) => [card.id, card] as const));
          for (const [id, card] of next) {
            const sent = sentThreads.get(id);
            if (sent === undefined || resourceKey(sent) !== resourceKey(card)) changed.push(card);
          }
          const gone = [...sentThreads.keys()].filter((id) => !next.has(id));
          sentThreads = next;
          if (gone.length > 0) {
            yield* send({ id: nextId(), type: "remove", provider: PROVIDER_NAME, ids: gone });
          }
        }
        if (changed.length > 0) {
          yield* send({
            id: nextId(),
            type: "upsert",
            provider: PROVIDER_NAME,
            resources: changed,
          });
        }
      });
      yield* Effect.sleep(FACTS_POLL).pipe(
        Effect.andThen(refreshCards),
        Effect.forever,
        Effect.forkScoped,
      );

      const exited = child.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach(handleLine),
        Effect.andThen(child.exitCode),
        Effect.flatMap((code) =>
          Fiber.join(stderr).pipe(
            Effect.map((text) => {
              const reason = KitshnCli.lastLine(text);
              return `kitshn provider exited with code ${Number(code)}${reason === undefined ? "" : `: ${reason}`}`;
            }),
          ),
        ),
        Effect.catchTags({
          RegisterRefused: (error) =>
            Effect.succeed(`kitshn refused the registration: ${error.error}`),
        }),
        Effect.orElseSucceed(() => "kitshn provider stopped"),
      );
      // Leaving this scope ends the child, so a child that stopped answering is replaced.
      const { ended, endedByT3 } = yield* Effect.raceFirst(
        exited.pipe(Effect.map((ended) => ({ ended, endedByT3: false }))),
        Deferred.await(unanswered).pipe(Effect.map((ended) => ({ ended, endedByT3: true }))),
      );
      return { ended, endedByT3, registered: yield* Deferred.isDone(registeredOnce) };
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        ended: error._tag === "KitshnCliError" ? error.message : "kitshn provider did not start",
        endedByT3: false,
        registered: false,
      }),
    ),
  );

  /** 1 s after a registered connection, then 5, 10, 20 and 30 s: 36 s in all, inside the 60 s. */
  const retryDelay = (failures: number) =>
    failures === 0
      ? RETRY_AFTER_REGISTER
      : Duration.min(Duration.times(RETRY_FIRST, 2 ** Math.min(failures - 1, 10)), RETRY_CAP);

  const connectForever = Effect.gen(function* () {
    let failures = 0;
    let lastEnded = "";
    while (true) {
      const { ended, endedByT3, registered: didRegister } = yield* connectOnce;
      failures = didRegister ? 0 : failures + 1;
      const endedAt = yield* Clock.currentTimeMillis;
      yield* Ref.set(restartNote, endedByT3 ? { reason: ended, at: endedAt } : null);
      const delay = retryDelay(failures);
      const message = `kitshn provider: ${ended}. It tries again in ${Duration.format(delay)}.`;
      // A machine without kitshn says the same thing on each try; log it once.
      yield* ended === lastEnded && !didRegister
        ? Effect.logDebug(message)
        : Effect.logInfo(message);
      lastEnded = ended;
      yield* SubscriptionRef.set(connection, { status: "connecting", detail: ended });
      yield* Effect.sleep(delay);
    }
  });

  const run: KitshnProvider["Service"]["run"] = Effect.gen(function* () {
    if (Option.isSome(ownerRefusal)) {
      yield* SubscriptionRef.set(connection, { status: "off", detail: ownerRefusal.value });
      return yield* Effect.logDebug(`kitshn provider: ${ownerRefusal.value}`);
    }
    return yield* connectForever;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("kitshn provider stopped.", { cause: String(cause) }),
    ),
  );

  const request: KitshnProvider["Service"]["request"] = Effect.fn("KitshnProvider.request")(
    function* (input) {
      const current = yield* Ref.get(live);
      if (Option.isNone(current)) {
        return yield* new KitshnRequestError({
          message:
            "This server has no connection to kitshn. It needs kitshn 2 on this machine, joined to kitshn, with its daemon running.",
        });
      }
      const answer = yield* current.value(input);
      if (answer.type === "error") return yield* new KitshnRequestError({ message: answer.error });
      return answer;
    },
  );

  yield* SubscriptionRef.changes(providerState).pipe(
    Stream.map(({ cardSettings }) =>
      cardSettings[APP_RESOURCE_ID]?.[UPDATE_CHANNEL_SETTING] === "daily" ? "daily" : "nightly",
    ),
    Stream.changes,
    Stream.runForEach(forkUpdates.setChannel),
    Effect.forkScoped,
  );

  return KitshnProvider.of({
    run,
    request,
    state: SubscriptionRef.changes(providerState),
    hostNotice: SubscriptionRef.changes(hostNotice),
    servedHosts: SubscriptionRef.changes(servedHosts),
    askResults: Ref.get(askResults),
    connection: SubscriptionRef.changes(connection),
    linkProxyState: Ref.get(linkProxy).pipe(
      Effect.map((proxy) => (proxy === null ? "none" : proxy.checked ? "checked" : "unchecked")),
    ),
    linkSocket: linkChecks.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(linkProxy);
        if (current === null) return null;
        if (current.checked) return current.path;
        const checked = yield* cli.linkCheck(current.path).pipe(
          Effect.map((output) => ({
            ok: output.exitCode === 0,
            text: output.stderr || output.stdout,
          })),
          Effect.catch((error) => Effect.succeed({ ok: false, text: error.message })),
        );
        if (!checked.ok) {
          yield* Effect.logWarning(
            `kitshn provider: link-check refused the link socket: ${checked.text.trim()}`,
          );
          return null;
        }
        // The connection may have closed or registered another path while the check ran.
        const latest = yield* Ref.updateAndGet(linkProxy, (now) =>
          now?.path === current.path ? { path: now.path, checked: true } : now,
        );
        return latest?.path === current.path && latest.checked ? current.path : null;
      }),
    ),
    linkSocketFailed: Effect.fn("KitshnProvider.linkSocketFailed")((socket: string) =>
      Ref.update(linkProxy, (current) =>
        current?.path === socket ? { path: socket, checked: false } : current,
      ),
    ),
  });
});

export const layer = Layer.effect(KitshnProvider, Effect.flatMap(makeListSharedThreads, make));
