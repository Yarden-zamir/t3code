/**
 * Fork: the T3 server as a kitshn provider (kitshn K-704 to K-707). While the server setting
 * `kitshnProvider` is on, the server runs `kitshn provider` of the machine's kitshn 2 and registers
 * its app card and commands. A missing kitshn, a refusal or an exit only logs, and the server
 * tries again later. Phase A: grants stay in memory and nothing checks them yet.
 */
import type { MachineCommandInput } from "@t3tools/contracts";
import { THREAD_CREDENTIAL_AUTHORIZATION_ENV } from "@t3tools/provider-core/server/forkThreadCredential";
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
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as MachineHost from "../machineMap/MachineHost.ts";
import { redactSecretsInText } from "../redactUrlSecrets.ts";
import { kitshnOwnerRefusal } from "./KitshnAttester.ts";
import * as KitshnCli from "./KitshnCli.ts";
import {
  type Answer,
  grantCount,
  type GrantTables,
  MAX_COMMAND_OUTPUT_LENGTH,
  PROVIDER_NAME,
  type ProviderCommand,
  type ProviderResource,
  type Request,
  decodeAnswer,
  requestLine,
} from "./kitshnProviderProtocol.ts";

// After a connection that registered: a daemon restart ends the child, and T3 comes back fast.
const RETRY_AFTER_REGISTER = Duration.seconds(1);
const RETRY_FIRST = Duration.seconds(5);
// After a daemon restart, a queued command waits 60 seconds for `register` (K-707).
const RETRY_CAP = Duration.seconds(30);
// Known limit: the busy count is polled, so the card can lag by this much. Revisit if kitshn
// starts "when idle" jobs (K-1608) that need a faster busy fact.
const FACTS_POLL = Duration.seconds(15);
// Below the daemon's 5-minute limit, so T3 answers before the daemon gives up.
const COMMAND_TIMEOUT = Duration.minutes(4.5);
// Time for the result line to reach the daemon before the process ends.
const RESTART_FLUSH = Duration.millis(500);
const STDERR_KEEP = 4096;

const APP_RESOURCE_ID = "app";

const KINDS = [
  { id: "t3.app", name: "T3 app", levels: { view: "read", use: "standard", control: "admin" } },
  { id: "t3.thread", name: "T3 thread", levels: { view: "view", use: "send" } },
  { id: "t3.agents", name: "T3 agents", levels: { use: "use", control: "exec" } },
] as const;

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

export class KitshnProvider extends Context.Service<
  KitshnProvider,
  {
    /** Follows the `kitshnProvider` setting for the life of the server. Never fails. */
    readonly run: Effect.Effect<void>;
    /** K-706: the last grant tables from kitshn. Phase A keeps them only. */
    readonly grants: Effect.Effect<GrantTables>;
  }
>()("t3/fork/kitshn/KitshnProvider") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const cli = yield* KitshnCli.KitshnCli;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const host = yield* MachineHost.MachineHost;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serviceScope = yield* Effect.scope;
  const ownerRefusal = yield* kitshnOwnerRefusal();
  const grants = yield* Ref.make<GrantTables>({});

  const registered: ReadonlyArray<KitshnCommand> = COMMANDS.filter((command) =>
    host.supportedCommands({ desktopConnected: false }).includes(command.input._tag),
  );
  const providerCommands: ReadonlyArray<ProviderCommand> = registered.map((command) => ({
    id: command.id,
    title: command.title,
    kinds: ["t3.app"],
    confirm: command.confirm,
  }));

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
      facts: [
        { label: "Version", value: descriptor.serverVersion, role: "version" },
        {
          label: "Running turns",
          value: Option.match(busy, { onNone: () => "unknown", onSome: String }),
          role: "busy",
        },
      ],
    } satisfies ProviderResource;
  });

  /** One `kitshn provider` child, until it exits. Returns why it ended and whether it registered. */
  const connectOnce = Effect.scoped(
    Effect.gen(function* () {
      // Phase B starts fail-closed: the grants of an ended connection are gone.
      yield* Effect.addFinalizer(() => Ref.set(grants, {}));
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

      const registerId = nextId();
      const registeredOnce = yield* Deferred.make<void>();
      const app = yield* appResource;
      let sentFacts = app.facts;
      yield* send({
        id: registerId,
        type: "register",
        provider: PROVIDER_NAME,
        kinds: KINDS,
        commands: providerCommands,
        resources: [app],
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
        switch (answer.type) {
          case "register":
            if (answer.id !== registerId) return;
            yield* Ref.set(grants, answer.grants);
            yield* Deferred.succeed(registeredOnce, undefined);
            return yield* Effect.logInfo(
              `kitshn provider: registered, with ${grantCount(answer.grants)} grants`,
            );
          case "grants":
            yield* Ref.set(grants, answer.tables);
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
          case "command-result":
            return;
        }
      });

      yield* Effect.sleep(FACTS_POLL).pipe(
        Effect.andThen(appResource),
        Effect.flatMap((current) => {
          if (JSON.stringify(current.facts) === JSON.stringify(sentFacts)) return Effect.void;
          sentFacts = current.facts;
          return send({
            id: nextId(),
            type: "upsert",
            provider: PROVIDER_NAME,
            resources: [current],
          });
        }),
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
    yield* Stream.concat(Stream.fromEffect(settings.getSettings), settings.streamChanges).pipe(
      Stream.map((current) => current.kitshnProvider),
      Stream.changes,
      Stream.switchMap((enabled) => (enabled ? Stream.fromEffect(connectForever) : Stream.empty)),
      Stream.runDrain,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("kitshn provider stopped.", { cause: String(cause) }),
    ),
  );

  return KitshnProvider.of({ run, grants: Ref.get(grants) });
});

export const layer = Layer.effect(KitshnProvider, make);
