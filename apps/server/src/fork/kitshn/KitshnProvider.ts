/**
 * Fork: the T3 server as a kitshn provider (kitshn K-704 to K-707), the only way this server joins
 * other machines. The server runs `kitshn provider` of the machine's kitshn 2 and registers its
 * cards and commands. A missing kitshn, a refusal or an exit only logs, and the server tries again
 * later; without kitshn 2 the server behaves as upstream (K-712). Its grant tables go to `KitshnGrants`, which enforces them.
 */
import type { MachineCommandInput } from "@t3tools/contracts";
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
  type ProviderResource,
  ProviderResource as ProviderResourceSchema,
  type AccessApp,
  type CardSettingValues,
  type DesiredParts,
  type LocalRequest,
  type ReachedCard,
  type LocalRequestInput,
  type Request,
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
// While the child runs, the daemon answers; this keeps the saved table fresh (K-706).
const CONTACT_TICK = Duration.minutes(1);
// kitshn holds 500 cards per machine for all providers (K-704).
const THREAD_CARDS_LIMIT = 200;
// Below the daemon's 5-minute limit, so T3 answers before the daemon gives up.
const COMMAND_TIMEOUT = Duration.minutes(4.5);
// Time for the result line to reach the daemon before the process ends.
const RESTART_FLUSH = Duration.millis(500);
const STDERR_KEEP = 4096;
// Above the daemon's own 30-second limit of a local request.
const LOCAL_REQUEST_TIMEOUT = Duration.seconds(35);

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

/** What kitshn keeps for this provider besides grants: the settings state and card settings. */
export interface KitshnProviderState {
  readonly settings: DesiredParts | null;
  readonly cardSettings: CardSettingValues;
  /** K-1609: the cards of other machines that this machine reaches. */
  readonly reach: ReadonlyArray<ReachedCard>;
}

/**
 * K-1623: the `t3.app` card stays without `site` until kitshn keeps the address off a card while
 * its live site is not `ok`. Today kitshn makes an Access application on the portal's host at once,
 * and the portal holds every T3 host in one shared Access app, so a site could break access to
 * every machine. The lead turns it on once that kitshn fix is merged and deployed.
 */
const SEND_SITE = false;

/** K-1623: the card's site: the label of the machine's current tunnel host and the real port. */
const appSite = (config: {
  readonly tunnelPairingUrl?: string | undefined;
  readonly port: number;
}) => {
  if (config.tunnelPairingUrl === undefined) return undefined;
  const label = new URL(config.tunnelPairingUrl).hostname.split(".", 1)[0] ?? "";
  return label.startsWith("t3-") ? { name: label, port: config.port } : undefined;
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
     * kitshn has not named the Access app of the host. Always false while `SEND_SITE` is off.
     */
    readonly hostNotice: Stream.Stream<boolean>;
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
  // The live registered connection, so `request` can use it.
  const live = yield* Ref.make<
    Option.Option<(request: LocalRequestInput) => Effect.Effect<Answer, KitshnRequestError>>
  >(Option.none());

  const registered: ReadonlyArray<KitshnCommand> = COMMANDS.filter((command) =>
    host.supportedCommands({ desktopConnected: false }).includes(command.input._tag),
  );
  const providerCommands: ReadonlyArray<ProviderCommand> = registered.map((command) => ({
    id: command.id,
    title: command.title,
    kinds: ["t3.app"],
    confirm: command.confirm,
  }));

  const site = appSite(yield* ServerConfig.ServerConfig);
  /** K-1623: one log line when the host is not with kitshn; Settings > Machines shows it too. */
  const setHostNotice = Effect.fn("KitshnProvider.setHostNotice")(function* (
    access: AccessApp | null,
  ) {
    const notWithKitshn = SEND_SITE && site !== undefined && access === null;
    const before = yield* SubscriptionRef.getAndSet(hostNotice, notWithKitshn);
    if (notWithKitshn && !before) {
      yield* Effect.logWarning(
        `This machine's host ${site.name} is not with kitshn. Run scripts/fork-host-handover.ts <machine>.`,
      );
    }
  });
  const appResource = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
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
      ...(SEND_SITE && site !== undefined ? { site } : {}),
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
      const nextId = () => String(++lastId);
      const send = (request: Request) => Queue.offer(outbox, requestLine(request));
      const waiting = new Map<string, Deferred.Deferred<Answer>>();
      const localRequest = Effect.fn("KitshnProvider.localRequest")(function* (
        request: LocalRequestInput,
      ) {
        const id = nextId();
        const answer = yield* Deferred.make<Answer>();
        waiting.set(id, answer);
        yield* send({ ...request, id } as LocalRequest);
        const received = yield* Deferred.await(answer).pipe(
          Effect.timeoutOption(LOCAL_REQUEST_TIMEOUT),
          Effect.ensuring(Effect.sync(() => waiting.delete(id))),
        );
        if (Option.isNone(received)) {
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
      });

      const handleCommand = Effect.fn("KitshnProvider.handleCommand")(function* (
        event: Extract<Answer, { readonly type: "command" }>,
      ) {
        const command = registered.find((entry) => entry.id === event.command);
        const outcome: MachineHost.CommandOutcome =
          command === undefined || event.resource !== APP_RESOURCE_ID
            ? {
                ok: false,
                result: null,
                error: `T3 has no command ${event.command} for ${event.resource ?? "the machine"}.`,
              }
            : yield* host.runInput(`kitshn:${event.commandId}`, command.input).pipe(
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
        if (yield* Deferred.isDone(registeredOnce)) yield* grants.contact;
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
          Effect.sleep(CONTACT_TICK).pipe(Effect.andThen(grants.contact), Effect.forever),
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

      const ended = yield* child.stdout.pipe(
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
      return { ended, registered: yield* Deferred.isDone(registeredOnce) };
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        ended: error._tag === "KitshnCliError" ? error.message : "kitshn provider did not start",
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
      const { ended, registered: didRegister } = yield* connectOnce;
      failures = didRegister ? 0 : failures + 1;
      const delay = retryDelay(failures);
      const message = `kitshn provider: ${ended}. It tries again in ${Duration.format(delay)}.`;
      // A machine without kitshn says the same thing on each try; log it once.
      yield* ended === lastEnded ? Effect.logDebug(message) : Effect.logInfo(message);
      lastEnded = ended;
      yield* Effect.sleep(delay);
    }
  });

  const run: KitshnProvider["Service"]["run"] = Effect.gen(function* () {
    if (Option.isSome(ownerRefusal)) {
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
