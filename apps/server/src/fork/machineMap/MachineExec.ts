/**
 * Fork: machine map, `machine_exec` (MM-1908) and its stream for `t3 machine exec` (MM-1919), as a
 * kitshn exec (K-722). This machine checks its caller's limits and asks its daemon to run the
 * command on the other machine; kitshn checks "runs commands" and the target's daemon runs it, so
 * T3 on the target is not involved.
 */
import type { Answer } from "@kitshn/local";
import {
  MACHINE_EXEC_MAX_OUTPUT_BYTES,
  type MachineExecInput,
  type MachineExecResult,
  MachineExecStreamChannel,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import type * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as KitshnConnection from "../kitshn/KitshnConnection.ts";
import * as KitshnProvider from "../kitshn/KitshnProvider.ts";
import { requireMachineExecCaller } from "./machineCallerAccess.ts";
import { NO_LINK } from "./machineAccess.ts";
import { dataFrame, type ExecSocket, makeLiveness, readFrame } from "./machineExecStream.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
/** K-722: the longest run kitshn takes; `t3 machine exec` without `--timeout` asks for it. */
const STREAM_TIMEOUT_SECONDS = 3600;
/** K-722: kitshn sends at most this much data in one frame. */
const CHUNK_BYTES = 16 * 1024;
/** K-722: output credit goes back in grants of this size, after the data is written out. */
const CREDIT_GRANT_BYTES = 256 * 1024;
/** How long `machine_exec` waits for the owner's approval before it answers `waiting`. */
const APPROVAL_WAIT = Duration.seconds(60);
const WAITING_RESULTS_KEPT = 20;
const TRUNCATED_MARKER = `\n[output truncated at ${MACHINE_EXEC_MAX_OUTPUT_BYTES} bytes]`;
const WAITING_MESSAGE =
  "Waiting for the owner's approval on kitshn. The command runs when the owner approves it; read its result later with machines_read (execResults).";

type ExecExit = Extract<Answer, { readonly type: "exec-exit" }>;
type ExecEvent = Extract<
  Answer,
  { readonly type: "exec-output" | "exec-exit" | "exec-stdin-credit" }
>;
type RanResult = Extract<MachineExecResult, { readonly outcome: "exited" | "timedOut" }>;

/** A run that `machine_exec` stopped waiting for; its result comes when the owner approves. */
export interface LateExecResult {
  readonly proposalId: string;
  /** `refused`: kitshn's reason when the run did not run or was cut. */
  readonly result: RanResult | { readonly machine: string; readonly refused: string };
}

/**
 * Each call acts for its own caller: the MCP request that it serves names the caller.
 *
 * @effect-expect-leaking McpInvocationContext | ThreadManagementService
 */
export class MachineExec extends Context.Service<
  MachineExec,
  {
    readonly exec: (
      input: MachineExecInput,
    ) => Effect.Effect<
      MachineExecResult,
      OrchestratorMcpFailure,
      McpInvocationContext.McpInvocationContext | ThreadManagement.ThreadManagementService
    >;
    /**
     * MM-1919: one `t3 machine exec` stream, on its socket, from the CLI of this machine. It never
     * fails: a refusal ends the stream with an `error` frame.
     */
    readonly stream: (
      client: ExecSocket,
    ) => Effect.Effect<
      void,
      never,
      | Scope.Scope
      | McpInvocationContext.McpInvocationContext
      | ThreadManagement.ThreadManagementService
    >;
    /** The results of runs that waited for approval past their call, newest first; then each change. */
    readonly lateResults: Stream.Stream<ReadonlyArray<LateExecResult>>;
  }
>()("t3/fork/machineMap/MachineExec") {}

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
const unreachable = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

/** K-722: a timeout ends the run with a signal and the reason "timed out after …". */
const timedOut = (exit: ExecExit) =>
  exit.signal !== null && exit.reason?.startsWith("timed out") === true;
/** The run never ran or was cut: refused by kitshn or the owner, the target offline, or a lost relay. */
const neverRan = (exit: ExecExit) => exit.exitCode === null && exit.signal === null;
/** K-722: kitshn's reasons for a refusal start with "refused"; the others are failures of the way. */
const failureOf = (reason: string) =>
  reason.startsWith("refused") ? denied(reason) : unreachable(reason);
/** The end of a run whose provider connection closed: the daemon kills it without a last frame. */
const relayLost = (execId: string): ExecExit => ({
  type: "exec-exit",
  execId,
  exitCode: null,
  signal: null,
  durationMs: 0,
  reason: "the relay was lost",
});

/** Output that keeps at most `MACHINE_EXEC_MAX_OUTPUT_BYTES`, then a marker. */
const makeCollector = () => {
  const chunks: Array<Uint8Array> = [];
  let kept = 0;
  let truncated = false;
  return {
    add: (bytes: Uint8Array) => {
      const room = MACHINE_EXEC_MAX_OUTPUT_BYTES - kept;
      if (bytes.byteLength > room) truncated = true;
      if (room <= 0) return;
      const part = bytes.byteLength > room ? bytes.subarray(0, room) : bytes;
      chunks.push(part);
      kept += part.byteLength;
    },
    text: () => {
      const all = new Uint8Array(kept);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder().decode(all);
      return truncated ? `${text}${TRUNCATED_MARKER}` : text;
    },
    truncated: () => truncated,
  };
};

const decodeData = (data: string): Uint8Array => Buffer.from(data, "base64");
const encodeData = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const BEARER = "Bearer ";

const make = Effect.gen(function* () {
  const kitshn = yield* KitshnConnection.KitshnConnection;
  const provider = yield* KitshnProvider.KitshnProvider;
  const serviceScope = yield* Effect.scope;
  const late = yield* SubscriptionRef.make<ReadonlyArray<LateExecResult>>([]);

  /** The reached machine by id or name (K-1609): a machine that this machine reaches by T3. */
  const resolveTarget = Effect.fn("MachineExec.resolveTarget")(function* (machine: string) {
    const state = yield* provider.state.pipe(Stream.runHead);
    const reach = Option.isSome(state) ? state.value.reach : [];
    const wanted = machine.trim().toLowerCase();
    const card = reach.find(
      (candidate) =>
        candidate.machineId === machine || candidate.machineName.toLowerCase() === wanted,
    );
    if (card === undefined) {
      return yield* denied(`No machine named "${machine}" is linked: ${NO_LINK}`);
    }
    return { id: card.machineId, name: card.machineName };
  });

  /**
   * Starts a run and returns its frames. The caller's thread token goes along, so kitshn knows the
   * thread that asks (K-1752). The subscription starts before the request, so no frame is lost.
   */
  const start = Effect.fn("MachineExec.start")(function* (input: {
    readonly machine: string;
    readonly command: string;
    readonly cwd?: string | undefined;
    readonly timeoutSeconds: number;
    readonly stdin: boolean;
  }) {
    const caller = yield* requireMachineExecCaller();
    const target = yield* resolveTarget(input.machine);
    const authorization = caller.scope.thread?.authorization;
    const header = authorization === undefined ? undefined : Redacted.value(authorization);
    const token = header?.startsWith(BEARER) === true ? header.slice(BEARER.length) : undefined;
    const subscription = yield* kitshn.subscribe;
    const connection = yield* kitshn.current;
    const answer = yield* kitshn
      .request({
        type: "exec",
        target: target.id,
        // Known limit: no `targetProvider`; send it once B has several providers and the daemon asks.
        command: input.command,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        timeoutSeconds: input.timeoutSeconds,
        stdin: input.stdin,
        ...(token === undefined ? {} : { attest: `t3:${token}` }),
      })
      .pipe(Effect.mapError((error) => unreachable(error.message)));
    const execId = answer.execId;
    const isOwnFrame = (event: KitshnConnection.DaemonEvent): event is ExecEvent =>
      (event.type === "exec-output" ||
        event.type === "exec-exit" ||
        event.type === "exec-stdin-credit") &&
      event.execId === execId;
    const nextFrame: Effect.Effect<ExecEvent> = PubSub.take(subscription).pipe(
      Effect.filterOrElse(isOwnFrame, () => nextFrame),
    );
    // A run lives on the connection that started it; another or none means the run is gone.
    const lost = yield* Deferred.make<void>();
    yield* kitshn.live.pipe(
      Stream.filter((live) => live !== connection),
      Stream.runHead,
      Effect.andThen(Deferred.succeed(lost, undefined)),
      Effect.forkScoped,
    );
    const next: Effect.Effect<ExecEvent> = Effect.raceFirst(
      nextFrame,
      Deferred.await(lost).pipe(Effect.as(relayLost(execId))),
    );
    return { target, execId, state: answer.state, proposalId: answer.proposalId, next };
  });

  /** Grants output credit back in batches, after the data is written out (K-722). */
  const makeCredit = (execId: string) => {
    let consumed = 0;
    return (bytes: number) => {
      consumed += bytes;
      if (consumed < CREDIT_GRANT_BYTES) return Effect.void;
      const grant = consumed;
      consumed = 0;
      return kitshn.notify({ type: "exec-credit", execId, bytes: grant }).pipe(Effect.ignore);
    };
  };

  /** Reads a run to its end, keeping its output for a `machine_exec` result. */
  const collect = Effect.fn("MachineExec.collect")(function* (run: {
    readonly target: { readonly name: string };
    readonly execId: string;
    readonly next: Effect.Effect<ExecEvent>;
  }) {
    const stdout = makeCollector();
    const stderr = makeCollector();
    const credit = makeCredit(run.execId);
    while (true) {
      const event = yield* run.next;
      if (event.type === "exec-output") {
        const bytes = decodeData(event.data);
        (event.stream === "stdout" ? stdout : stderr).add(bytes);
        yield* credit(bytes.byteLength);
        continue;
      }
      if (event.type !== "exec-exit") continue;
      if (neverRan(event)) {
        return { notRun: event.reason ?? "kitshn did not run the command." } as const;
      }
      return {
        machine: run.target.name,
        outcome: timedOut(event) ? "timedOut" : "exited",
        exitCode: event.exitCode,
        signal: event.signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
        durationMs: Math.max(0, Math.round(event.durationMs)),
      } satisfies RanResult;
    }
  });

  const exec: MachineExec["Service"]["exec"] = Effect.fn("MachineExec.exec")(function* (input) {
    // The run's subscription outlives this call when it waits for the owner, so it has its own scope.
    const runScope = yield* Scope.make();
    const release = Scope.close(runScope, Exit.void);
    const run = yield* start({
      machine: input.machine,
      command: input.command,
      cwd: input.cwd,
      timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      stdin: false,
    }).pipe(
      Scope.provide(runScope),
      Effect.onError(() => release),
    );
    // One reader of the run: a late approval keeps the output that came before the call gave up.
    const reader = yield* collect(run).pipe(Effect.forkIn(serviceScope));
    const kill = kitshn
      .request({ type: "exec-close", execId: run.execId, what: "kill" })
      .pipe(Effect.ignore);
    const collected = yield* (
      run.state === "waiting"
        ? Fiber.join(reader).pipe(Effect.timeoutOption(APPROVAL_WAIT))
        : Effect.asSome(Fiber.join(reader))
    ).pipe(Effect.onInterrupt(() => Effect.all([kill, Fiber.interrupt(reader), release])));
    if (Option.isSome(collected)) {
      yield* release;
      const ended = collected.value;
      return "notRun" in ended ? yield* failureOf(ended.notRun) : ended;
    }
    // The owner has not answered: the run goes on in the background, and its result waits.
    const proposalId = run.proposalId ?? run.execId;
    yield* Fiber.join(reader).pipe(
      Effect.flatMap((ended) =>
        SubscriptionRef.update(late, (results) =>
          [
            {
              proposalId,
              result:
                "notRun" in ended ? { machine: run.target.name, refused: ended.notRun } : ended,
            },
            ...results,
          ].slice(0, WAITING_RESULTS_KEPT),
        ),
      ),
      Effect.ensuring(release),
      Effect.forkIn(serviceScope),
    );
    return {
      machine: run.target.name,
      outcome: "waiting",
      proposalId,
      message: WAITING_MESSAGE,
    } satisfies MachineExecResult;
  });

  /** MM-1919: relays one `t3 machine exec` stream between the CLI and kitshn. */
  const relay = Effect.fn("MachineExec.relay")(function* (
    client: ExecSocket,
    firstFrames: ReadonlyArray<Uint8Array | string>,
    run: Effect.Success<ReturnType<typeof start>>,
  ) {
    const liveness = yield* makeLiveness;
    const credit = makeCredit(run.execId);
    // K-722: each run starts with 64 KiB of stdin credit; `exec-stdin-credit` gives it back.
    const stdinCredit = yield* SubscriptionRef.make(64 * 1024);
    const waitForCredit = (bytes: number) =>
      SubscriptionRef.changes(stdinCredit).pipe(
        Stream.filter((left) => left >= bytes),
        Stream.runHead,
        Effect.andThen(SubscriptionRef.update(stdinCredit, (left) => left - bytes)),
      );
    const sendStdin = Effect.fn("MachineExec.sendStdin")(function* (bytes: Uint8Array) {
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
        yield* liveness.whileWaitingHere(waitForCredit(chunk.byteLength));
        yield* kitshn.request({
          type: "exec-input",
          execId: run.execId,
          data: encodeData(chunk),
        });
      }
    });
    // A stdin that kitshn refused stays closed; the run goes on and its exit still comes.
    let stdinOpen = true;
    const closeStdinOnError = <E>(effect: Effect.Effect<unknown, E>) =>
      effect.pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            stdinOpen = false;
          }),
        ),
      );
    const handleClientFrames = Effect.fn("MachineExec.handleClientFrames")(function* (
      frames: ReadonlyArray<Uint8Array | string>,
    ) {
      yield* liveness.touch;
      for (const raw of frames) {
        const frame = readFrame(raw);
        if (!stdinOpen) continue;
        if (frame._tag === "data" && frame.channel === MachineExecStreamChannel.stdin) {
          yield* closeStdinOnError(sendStdin(frame.bytes));
          // A refused chunk ends stdin, so a command that reads it does not wait for its timeout.
          if (!stdinOpen) {
            yield* kitshn
              .request({ type: "exec-close", execId: run.execId, what: "stdin" })
              .pipe(Effect.ignore);
          }
        } else if (frame._tag === "message" && frame.message.type === "eof") {
          stdinOpen = false;
          yield* closeStdinOnError(
            kitshn.request({ type: "exec-close", execId: run.execId, what: "stdin" }),
          );
        }
      }
    });
    const fromClient = Effect.gen(function* () {
      yield* handleClientFrames(firstFrames);
      while (true) yield* handleClientFrames(yield* client.pull);
    });
    const fromKitshn = Effect.gen(function* () {
      while (true) {
        const event = yield* run.next;
        if (event.type === "exec-stdin-credit") {
          yield* SubscriptionRef.update(stdinCredit, (left) => left + event.bytes);
          continue;
        }
        if (event.type === "exec-output") {
          const bytes = decodeData(event.data);
          const channel =
            event.stream === "stdout"
              ? MachineExecStreamChannel.stdout
              : MachineExecStreamChannel.stderr;
          // The send waits for the network, so a slow CLI holds the credit and the command.
          yield* liveness.whileWaitingHere(client.send(dataFrame(channel, bytes)));
          yield* credit(bytes.byteLength);
          continue;
        }
        return event;
      }
    });
    const ended = yield* Effect.raceAllFirst([
      fromKitshn.pipe(Effect.map((exit) => ({ _tag: "exit" as const, exit }))),
      fromClient.pipe(Effect.as({ _tag: "gone" as const })),
      liveness.watch(client.message({ type: "ping" })).pipe(Effect.as({ _tag: "gone" as const })),
    ]).pipe(Effect.orElseSucceed(() => ({ _tag: "gone" as const })));
    if (ended._tag === "gone") {
      // The CLI went away: the run ends on the other machine too.
      return yield* kitshn
        .request({ type: "exec-close", execId: run.execId, what: "kill" })
        .pipe(Effect.ignore);
    }
    const { exit } = ended;
    if (neverRan(exit)) {
      return yield* client.message({
        type: "error",
        message: exit.reason ?? "kitshn did not run the command.",
      });
    }
    if (timedOut(exit)) {
      return yield* client.message({ type: "exit", outcome: "timedOut", exitCode: null });
    }
    return yield* client.message({
      type: "exit",
      outcome: "exited",
      exitCode: exit.exitCode,
      ...(exit.exitCode === null
        ? { message: `${exit.signal ?? "A signal"} ended the command.` }
        : {}),
    });
  });

  const stream: MachineExec["Service"]["stream"] = Effect.fn("MachineExec.stream")(
    function* (client) {
      const [head, ...rest] = yield* client.pull;
      const frame = head === undefined ? undefined : readFrame(head);
      if (frame?._tag !== "message" || frame.message.type !== "start") {
        return yield* client.message({
          type: "error",
          message: "A machine exec stream starts with a start frame.",
        });
      }
      const begin = frame.message;
      const run = yield* start({
        machine: begin.machine,
        command: begin.command,
        cwd: begin.cwd,
        timeoutSeconds: Math.min(
          begin.timeoutSeconds ?? STREAM_TIMEOUT_SECONDS,
          STREAM_TIMEOUT_SECONDS,
        ),
        stdin: true,
      });
      if (run.state === "waiting") {
        yield* client.message({ type: "waiting", proposalId: run.proposalId ?? run.execId });
      }
      yield* relay(client, rest, run);
    },
    (effect, client) =>
      effect.pipe(
        Effect.catch((error) =>
          client.message({ type: "error", message: error.message }).pipe(Effect.ignore),
        ),
        Effect.ensuring(client.close),
      ),
  );

  return MachineExec.of({ exec, stream, lateResults: SubscriptionRef.changes(late) });
});

export const layer = Layer.effect(MachineExec, make);
