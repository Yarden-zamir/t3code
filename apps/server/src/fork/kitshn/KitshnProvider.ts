/**
 * Fork: the T3 server as a kitshn provider (protocol 2, K-704 to K-707, K-721, K-722), the only way
 * this server joins other machines. The server runs `kitshn provider` of the machine's kitshn 2 and
 * registers its cards and commands. A missing kitshn, a refusal or an exit only logs, and the server
 * tries again later; without kitshn 2 the server behaves as upstream (K-712).
 */
import {
  type Answer,
  type CardSettingValues,
  type DesiredParts,
  line as requestLine,
  PROVIDER_PROTOCOL,
  type ProviderClient,
  type ProviderCommand,
  type ProviderList,
  type ProviderProblem,
  type ProviderResource,
  type ReachedCard,
  readAnswer,
  type Request,
} from "@kitshn/local";
import type { MachineCommandInput, MachineStatus } from "@t3tools/contracts";
import {
  KITSHN_ATTEST_ENV,
  THREAD_CREDENTIAL_AUTHORIZATION_ENV,
} from "@t3tools/provider-core/server/forkThreadCredential";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ForkUpdates from "../ForkUpdates.ts";
import * as MachineHost from "../machineMap/MachineHost.ts";
import { redactSecretsInText } from "../redactUrlSecrets.ts";
import * as ThreadIdentity from "../ThreadIdentity.ts";
import { attestedLabels } from "./kitshnAttest.ts";
import * as KitshnCli from "./KitshnCli.ts";
import * as KitshnConnection from "./KitshnConnection.ts";
import { APP_RESOURCE_ID, KINDS, threadResourceId } from "./kitshnGrantRules.ts";
import { makeListSharedThreads, type SharedThread } from "./sharedThreads.ts";

export const PROVIDER_NAME = "t3";
/** K-707: the longest `output` of a command result. */
const MAX_COMMAND_OUTPUT_LENGTH = 64 * 1024;

// After a connection that registered: a daemon restart ends the child, and T3 comes back fast.
const RETRY_AFTER_REGISTER = Duration.seconds(1);
const RETRY_FIRST = Duration.seconds(5);
// After a daemon restart, a queued command waits 60 seconds for `register` (K-707).
const RETRY_CAP = Duration.seconds(30);
// Known limit: the busy count, the lists and the thread cards are read this often, and kitshn gets
// an upsert only when a card changed. Revisit when tasks, client sessions and guest shares have
// change streams: then upsert on each change instead of reading.
const FACTS_POLL = Duration.seconds(15);
// kitshn holds 500 cards per machine for all providers (K-704).
const THREAD_CARDS_LIMIT = 200;
// The result must reach the daemon before the job's deadline.
const DEADLINE_MARGIN = Duration.seconds(2);
// Time for the result line to reach the daemon before the process ends.
const RESTART_FLUSH = Duration.millis(500);
const STDERR_KEEP = 4096;
// The daemon answers local requests itself, except an ask, which waits up to 60 seconds for kitshn.
const LOCAL_REQUEST_TIMEOUT = Duration.seconds(35);
const ASK_TIMEOUT = Duration.seconds(65);
// The daemon answers `register` itself, so a silent child is stuck.
const REGISTER_TIMEOUT = Duration.seconds(10);
// K-1752: the daemon refuses an attestation after 2 seconds, so T3 answers inactive a bit before.
const ATTEST_LIMIT = Duration.millis(1800);
const RESULTS_KEPT = 50;

/**
 * K-704: the daemon has no error code for this, only the text. The connection is new to the daemon,
 * so nothing on this child can work again; T3 ends it and registers on a new one.
 */
const isNotRegistered = (error: string) => error.includes("on this connection first");

const resourceKey = (resource: ProviderResource) => JSON.stringify(resource);

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

/**
 * The machine map command of a row command, or undefined when the row is not of its list. A row id
 * is the prefix and the id itself; the daemon drops a row whose id is longer than its limit.
 */
const rowCommandInput = (command: string, row: string) => {
  const entry = ROW_COMMANDS.find((candidate) => candidate.id === command);
  if (entry === undefined || !row.startsWith(entry.row) || row.length === entry.row.length) {
    return undefined;
  }
  return entry.input(row.slice(entry.row.length));
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
      id: `${TASK_ROW}${task.id}`,
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
      id: `${SESSION_ROW}${session.sessionId}`,
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
/** The switch that keeps this server off kitshn. */
const KITSHN_SWITCH_ENV = "T3CODE_KITSHN";

const OBTAINIUM_FORK_APP =
  "https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22com.yardenzamir.t3code%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2FYarden-zamir%2Ft3code%22%2C%22author%22%3A%22Yarden-zamir%22%2C%22name%22%3A%22T3%20Code%20fork%22%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Atrue%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22android%5C%5C%5C%5C.apk%24%5C%22%7D%22%7D";

/**
 * The apps that open a kitshn device invite; they fill Settings > Connections > New with it.
 * The store app has no `inviteUrl` deep link, so only the fork app is listed.
 */
const CLIENT_APPS: ReadonlyArray<ProviderClient> = [
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
export type KitshnConnectionStatus =
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

/** What kitshn keeps for this provider and says about it. */
export interface KitshnProviderState {
  readonly settings: DesiredParts | null;
  readonly cardSettings: CardSettingValues;
  /** K-1609: the cards of other machines that this machine reaches. */
  readonly reach: ReadonlyArray<ReachedCard>;
  /** K-721: when kitshn last answered the daemon; null before the first contact. */
  readonly syncedAt: number | null;
  /** K-721: kitshn's emergency pause. */
  readonly paused: boolean;
  /** The items that the daemon dropped from the last register or upsert. */
  readonly problems: ReadonlyArray<ProviderProblem>;
}

type AskResult = Extract<Answer, { readonly type: "ask-result" }>;
type JobResult = Extract<Answer, { readonly type: "job-result" }>;

export class KitshnProvider extends Context.Service<
  KitshnProvider,
  {
    /** Connects to kitshn for the life of the server, and again after each exit. Never fails. */
    readonly run: Effect.Effect<void>;
    /** The last state from kitshn, then each change. */
    readonly state: Stream.Stream<KitshnProviderState>;
    /** K-1609: the link proxy of the live connection, or null. It goes when the connection closes. */
    readonly linkSocket: Effect.Effect<string | null>;
    /** K-1611: the connection now, then each change. */
    readonly connection: Stream.Stream<KitshnConnectionStatus>;
    /** K-1722: the answers to this machine's waiting asks, newest first. */
    readonly askResults: Effect.Effect<ReadonlyArray<AskResult>>;
    /** K-1612: the ends of the jobs that this machine queued, newest first. */
    readonly jobResults: Effect.Effect<ReadonlyArray<JobResult>>;
  }
>()("t3/fork/kitshn/KitshnProvider") {}

/** Why this server does not speak for the machine, or none. */
const kitshnOff = (input: {
  readonly devUrl: URL | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}): string | undefined => {
  // A dev server would replace the machine's installed T3 as the provider instance.
  if (input.devUrl !== undefined) return "a dev server does not register with kitshn";
  return input.env[KITSHN_SWITCH_ENV]?.trim().toLowerCase() === "off"
    ? `turned off by ${KITSHN_SWITCH_ENV}=off`
    : undefined;
};

export const make = Effect.fn("KitshnProvider.make")(function* (
  /** The threads with an open guest share, or none when the read failed. */
  listSharedThreads: Effect.Effect<Option.Option<ReadonlyArray<SharedThread>>>,
) {
  const cli = yield* KitshnCli.KitshnCli;
  const kitshn = yield* KitshnConnection.KitshnConnection;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const host = yield* MachineHost.MachineHost;
  const forkUpdates = yield* ForkUpdates.ForkUpdates;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const identity = yield* ThreadIdentity.ThreadIdentity;
  const config = yield* ServerConfig.ServerConfig;
  const serviceScope = yield* Effect.scope;
  const off = kitshnOff({ devUrl: config.devUrl, env: yield* HostProcess.Environment });
  const providerState = yield* SubscriptionRef.make<KitshnProviderState>({
    settings: null,
    cardSettings: {},
    reach: [],
    syncedAt: null,
    paused: false,
    problems: [],
  });
  const linkSocket = yield* Ref.make<string | null>(null);
  const askResults = yield* Ref.make<ReadonlyArray<AskResult>>([]);
  const jobResults = yield* Ref.make<ReadonlyArray<JobResult>>([]);
  const connection = yield* SubscriptionRef.make<KitshnConnectionStatus>({
    status: "connecting",
    detail: null,
  });
  // Why T3 ended the last child itself, so the next registered connection can show it.
  const restartNote = yield* Ref.make<{ readonly reason: string; readonly at: number } | null>(
    null,
  );

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

  const appStatus = host.status({
    desktopConnected: false,
    updateWaiting: null,
    desktopBuild: null,
  });
  const appResource = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    const status = yield* appStatus;
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
      // K-705: kitshn names the site and keeps the name of a site that it served before.
      site: { port: config.port },
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

  /** K-1752: who holds an agent's token; `active: false` when T3 cannot say in time. */
  const attest = Effect.fn("KitshnProvider.attest")(function* (token: string) {
    const checked = yield* identity.check(token).pipe(
      Effect.timeoutOption(ATTEST_LIMIT),
      Effect.catch((cause) =>
        Effect.logWarning("kitshn attest: the thread check failed.", { cause: String(cause) }).pipe(
          Effect.as(Option.none()),
        ),
      ),
    );
    return Option.isSome(checked) && checked.value.active
      ? { active: true, labels: attestedLabels(checked.value) }
      : { active: false };
  });

  /** One `kitshn provider` child, until it exits. Returns why it ended and whether it registered. */
  const connectOnce = Effect.scoped(
    Effect.gen(function* () {
      const binary = yield* cli.binary;
      const child = yield* spawner.spawn(
        ChildProcess.make(binary, ["provider"], {
          // The server env can hold the credential of an agent shell that started it.
          env: { [THREAD_CREDENTIAL_AUTHORIZATION_ENV]: "", [KITSHN_ATTEST_ENV]: "" },
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
      const nextId = () => String(++lastId);
      const send = (request: Request) => Queue.offer(outbox, requestLine(request));
      const waiting = new Map<string, Deferred.Deferred<Answer>>();
      const unanswered = yield* Deferred.make<string>();
      // K-704: the daemon pings every `pingMs`; silence for `graceMs` means a lost connection.
      let lastLineAt = yield* Clock.currentTimeMillis;
      const localRequest = Effect.fn("KitshnProvider.localRequest")(function* (
        request: KitshnConnection.LocalRequestInput,
      ) {
        const id = nextId();
        const answer = yield* Deferred.make<Answer>();
        waiting.set(id, answer);
        yield* send({ ...request, id } as Request);
        const received = yield* Deferred.await(answer).pipe(
          Effect.timeoutOption(request.type === "ask" ? ASK_TIMEOUT : LOCAL_REQUEST_TIMEOUT),
          Effect.ensuring(Effect.sync(() => waiting.delete(id))),
        );
        if (Option.isNone(received)) {
          return yield* new KitshnConnection.KitshnRequestError({
            message: "kitshn did not answer in time.",
          });
        }
        return received.value;
      });
      yield* Effect.addFinalizer(() =>
        Effect.all([kitshn.attach(null), Ref.set(linkSocket, null)], { discard: true }),
      );

      const registerId = nextId();
      const registeredOnce = yield* Deferred.make<KitshnConnection.RegisterAnswer>();
      const app = yield* appResource;
      let sentApp = resourceKey(app);
      // K-704: register only with the full list; a card that it leaves out goes offline.
      let sentThreads = new Map(
        Option.getOrElse(yield* threadCards, () => []).map((card) => [card.id, card] as const),
      );
      yield* send({
        id: registerId,
        type: "register",
        protocol: PROVIDER_PROTOCOL,
        provider: PROVIDER_NAME,
        instance: yield* environment.getEnvironmentId,
        kinds: REGISTERED_KINDS,
        commands: providerCommands,
        resources: [app, ...sentThreads.values()],
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
      // After the answer: a daemon that sends nothing for `graceMs` is gone (SIGSTOP, a lost socket).
      yield* Deferred.await(registeredOnce).pipe(
        Effect.flatMap(({ graceMs }) =>
          Effect.gen(function* () {
            while (true) {
              const silentFor = (yield* Clock.currentTimeMillis) - lastLineAt;
              if (silentFor >= graceMs) {
                return yield* Deferred.succeed(
                  unanswered,
                  `kitshn sent nothing for ${Duration.format(Duration.millis(graceMs))}, so T3 ended the connection`,
                );
              }
              yield* Effect.sleep(Duration.millis(graceMs - silentFor));
            }
          }),
        ),
        Effect.forkScoped,
      );

      const handleCommand = Effect.fn("KitshnProvider.handleCommand")(function* (
        event: Extract<Answer, { readonly type: "command" }>,
      ) {
        const input =
          event.row === null
            ? registered.find((entry) => entry.id === event.command)?.input
            : rowCommandInput(event.command, event.row);
        const left = Duration.subtract(
          Duration.millis(Math.max(0, event.deadline - (yield* Clock.currentTimeMillis))),
          DEADLINE_MARGIN,
        );
        const outcome: MachineHost.CommandOutcome =
          input === undefined || event.resource !== APP_RESOURCE_ID
            ? {
                ok: false,
                result: null,
                error: `T3 has no command ${event.command} for ${event.row ?? event.resource ?? "the machine"}.`,
              }
            : yield* host.runInput(`kitshn:${event.commandId}`, input).pipe(
                Effect.timeoutOption(left),
                Effect.map(
                  Option.getOrElse((): MachineHost.CommandOutcome => ({
                    ok: false,
                    result: null,
                    error: "The command did not finish before kitshn's deadline.",
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

      const onRegistered = Effect.fn("KitshnProvider.onRegistered")(function* (
        answer: KitshnConnection.RegisterAnswer,
      ) {
        yield* SubscriptionRef.set(providerState, {
          settings: answer.saved.desired[SETTINGS_KIND] ?? null,
          cardSettings: answer.saved.settings,
          reach: answer.saved.reach,
          syncedAt: answer.syncedAt,
          paused: false,
          problems: answer.problems,
        });
        yield* Ref.set(linkSocket, answer.linkSocket);
        yield* kitshn.attach({
          answer,
          request: localRequest,
          notify: (notice) => send(notice).pipe(Effect.asVoid),
        });
        const note = yield* Ref.get(restartNote);
        const registeredStatus: KitshnConnectionStatus = {
          status: "registered",
          detail: note?.reason ?? null,
          restartedAt: note?.at ?? null,
        };
        yield* SubscriptionRef.set(connection, registeredStatus);
        yield* Deferred.succeed(registeredOnce, answer);
        if (answer.problems.length > 0) {
          yield* Effect.logWarning(
            `kitshn provider: registered; kitshn dropped ${answer.problems.length} items.`,
            { problems: answer.problems },
          );
        }
        return yield* Effect.logInfo("kitshn provider: registered");
      });

      // Untraced: one span per stdout line would be noise.
      const handleLine = Effect.fnUntraced(function* (text: string) {
        if (text.trim() === "") return;
        lastLineAt = yield* Clock.currentTimeMillis;
        const decoded = yield* Effect.try(() => readAnswer(text)).pipe(Effect.option);
        if (Option.isNone(decoded) || decoded.value === null) {
          // Protocol 2 is additive: an unknown event is skipped. The line can hold secrets.
          return yield* Effect.logWarning(
            `kitshn provider: skipped a line that is not a known answer or event (${text.length} characters)`,
          );
        }
        const answer = decoded.value;
        if (answer.type === "error" && isNotRegistered(answer.error)) {
          yield* Deferred.succeed(unanswered, `kitshn answered: ${answer.error}`);
        }
        if (!KitshnConnection.isDaemonEvent(answer)) {
          if (answer.id === null) {
            return answer.type === "error"
              ? yield* Effect.logWarning(`kitshn provider: kitshn refused: ${answer.error}`)
              : undefined;
          }
          const asked = waiting.get(answer.id);
          if (asked !== undefined) return yield* Deferred.succeed(asked, answer);
          if (answer.id === registerId) {
            if (answer.type === "register") return yield* onRegistered(answer);
            if (answer.type === "error") return yield* new RegisterRefused({ error: answer.error });
          }
          if (answer.type === "upsert" && answer.problems !== undefined) {
            const problems = answer.problems;
            return yield* SubscriptionRef.update(providerState, (current) => ({
              ...current,
              problems,
            }));
          }
          if (answer.type === "error") {
            return yield* Effect.logWarning(`kitshn provider: kitshn refused: ${answer.error}`);
          }
          return;
        }
        switch (answer.type) {
          case "ping":
            return yield* send({ type: "pong" });
          case "attest":
            return yield* attest(answer.token).pipe(
              Effect.flatMap((result) =>
                send({ id: nextId(), type: "attest-result", attestId: answer.attestId, ...result }),
              ),
              Effect.forkScoped,
              Effect.asVoid,
            );
          case "command":
            return yield* handleCommand(answer).pipe(Effect.forkScoped, Effect.asVoid);
          case "desired":
            yield* kitshn.publish(answer);
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
          case "reach":
            yield* kitshn.publish(answer);
            return yield* SubscriptionRef.update(providerState, (current) => ({
              ...current,
              reach: answer.cards,
            }));
          case "sync":
            return yield* SubscriptionRef.update(providerState, (current) => ({
              ...current,
              syncedAt: answer.syncedAt,
              paused: answer.paused,
            }));
          case "ask-result":
            return yield* Ref.update(askResults, (results) =>
              [answer, ...results].slice(0, RESULTS_KEPT),
            );
          case "job-result":
            return yield* Ref.update(jobResults, (results) =>
              [answer, ...results].slice(0, RESULTS_KEPT),
            );
          default:
            // `grants-changed`, exec frames and `served` go to their readers.
            return yield* kitshn.publish(answer);
        }
      });

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
      // A child that T3 ended itself backs off too, so a daemon that keeps refusing is no tight loop.
      failures = didRegister && !endedByT3 ? 0 : failures + 1;
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
    if (off !== undefined) {
      yield* SubscriptionRef.set(connection, { status: "off", detail: off });
      return yield* Effect.logDebug(`kitshn provider: ${off}`);
    }
    return yield* connectForever;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("kitshn provider stopped.", { cause: String(cause) }),
    ),
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
    state: SubscriptionRef.changes(providerState),
    askResults: Ref.get(askResults),
    jobResults: Ref.get(jobResults),
    connection: SubscriptionRef.changes(connection),
    linkSocket: Ref.get(linkSocket),
  });
});

export const layer = Layer.effect(KitshnProvider, Effect.flatMap(makeListSharedThreads, make));
