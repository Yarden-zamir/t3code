/**
 * Fork: machine map, `machine_exec` (MM-1908, MM-1909) and its stream for `t3 machine exec`
 * (MM-1919). An agent of this machine sends the call to another machine through `MachinePeers`. A
 * session of another machine runs the command here, as the user of this server. Only the arrow and
 * the caller limits control a run: no list of commands or patterns grants or refuses one (MM-1909).
 */
import {
  MACHINE_EXEC_MAX_OUTPUT_BYTES,
  type MachineExecInput,
  MachineExecStreamChannel,
  type MachineExecStreamStart,
  type MachineExecOutcome,
  type MachineExecResult,
  type MachineId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { kitshnAgentsAllowMachine } from "../kitshn/kitshnAgents.ts";
import * as KitshnGrants from "../kitshn/KitshnGrants.ts";
import { historyCaller } from "./machineCallerAccess.ts";
import { expandHomePath } from "../../os-jank.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { execArrowInto, machineOfRequestNamespace } from "./machineAccess.ts";
import { dataFrame, type ExecSocket, makeLiveness, readFrame } from "./machineExecStream.ts";
import * as MachineMap from "./MachineMap.ts";
import * as MachineMapState from "./MachineMapState.ts";
import * as MachinePeers from "./MachinePeers.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
// Stops a command that ignores SIGTERM, as `ProcessRunner` does.
const FORCE_KILL_AFTER = Duration.seconds(1);
/** Stdin chunks that wait for a command before the stream stops reading the caller. */
const STDIN_CHUNKS = 16;
/** The History keeps the start of a long command, so one run cannot fill the portal. */
const REPORTED_COMMAND_CHARS = 2_000;
const TRUNCATED_MARKER = `\n[output truncated at ${MACHINE_EXEC_MAX_OUTPUT_BYTES} bytes]`;

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
      MachinePeers.MachinePeerError | OrchestratorMcpFailure,
      Effect.Services<ReturnType<MachinePeers.MachinePeers["Service"]["exec"]>>
    >;
    /**
     * MM-1919: one `t3 machine exec` stream, on its socket. On this machine the caller is the CLI,
     * and this machine sends the stream on to the target. On the target it runs the command. It
     * never fails: a refusal ends the stream with an `error` frame.
     */
    readonly stream: (
      client: ExecSocket,
    ) => Effect.Effect<
      void,
      never,
      Scope.Scope | Effect.Services<ReturnType<MachinePeers.MachinePeers["Service"]["openExec"]>>
    >;
  }
>()("t3/fork/machineMap/MachineExec") {}

/** What every run needs, from `machine_exec` and from the stream. */
type ExecRequest = Omit<MachineExecInput, "timeoutSeconds">;

/** How a stream ended on the machine that ran it. */
type StreamEnd =
  /** A command that a signal ended has no exit code. */
  | { readonly _tag: "exited"; readonly exitCode: number | null }
  | { readonly _tag: "timedOut" }
  | { readonly _tag: "stopped"; readonly message: string }
  | { readonly _tag: "failed"; readonly message: string };

/** Windows PowerShell ships with every Windows; `pwsh` does not. */
const shellFor = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) =>
  platform === "win32"
    ? { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] }
    : {
        command: env.SHELL !== undefined && env.SHELL.length > 0 ? env.SHELL : "/bin/sh",
        args: ["-c"],
      };

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

const make = Effect.gen(function* () {
  const state = yield* MachineMapState.MachineMapState;
  const peers = yield* MachinePeers.MachinePeers;
  const machineMap = yield* MachineMap.MachineMap;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const allowedNow = Effect.fn("MachineExec.allowedNow")(function* (from: MachineId) {
    const desired = yield* state.activeDesired;
    if (desired === null) return undefined;
    const arrow = execArrowInto(desired, from, yield* Clock.currentTimeMillis);
    // kitshn provider (K-706): a `t3.agents` grant of `exec` as well.
    if (arrow === undefined || !(yield* kitshnAgentsAllowMachine(desired, from, "exec"))) {
      return undefined;
    }
    return arrow;
  });

  /**
   * MM-1916: completes when the arrow stops allowing exec: a new desired state (arrow change,
   * removal, pause, map off) or the expiry of a temporary level.
   */
  const lostAccess = (from: MachineId, expiresAt: string | null) => {
    const changed = state.changes.pipe(
      Stream.mapEffect(() => allowedNow(from)),
      Stream.filter((arrow) => arrow === undefined),
      Stream.runHead,
      Effect.asVoid,
    );
    const kitshnLost = Effect.serviceOption(KitshnGrants.KitshnGrants).pipe(
      Effect.flatMap((grants) =>
        Option.isNone(grants)
          ? Effect.never
          : grants.value.awaitLoss(
              allowedNow(from).pipe(Effect.map((arrow) => arrow !== undefined)),
            ),
      ),
    );
    if (expiresAt === null) return Effect.raceFirst(changed, kitshnLost);
    const expired = Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMs) => Effect.sleep(Duration.millis(Date.parse(expiresAt) - nowMs))),
      Effect.andThen(allowedNow(from)),
      Effect.flatMap((arrow) => (arrow === undefined ? Effect.void : Effect.never)),
    );
    return Effect.raceAllFirst([changed, expired, kitshnLost]);
  };

  /** MM-1908: a refused call in the History. No command ran, so it has no output or exit code. */
  const reportRefused = Effect.fn("MachineExec.reportRefused")(function* (refusal: {
    readonly from: MachineId;
    /** The machine that the command was for, when the calling machine reports its refusal. */
    readonly target?: MachineId;
    readonly input: ExecRequest;
    readonly reason: string;
  }) {
    yield* machineMap.reportExec({
      id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
      at: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
      from: refusal.from,
      threadId: refusal.input.caller?.threadId ?? null,
      threadTitle: refusal.input.caller?.threadTitle ?? null,
      command: refusal.input.command.slice(0, REPORTED_COMMAND_CHARS),
      cwd: refusal.input.cwd ?? "~",
      outcome: "refused",
      exitCode: null,
      durationMs: 0,
      reason: refusal.reason,
      ...(refusal.target === undefined ? {} : { target: refusal.target }),
    });
  });

  /** The checks of a run here, and the report of its end (MM-1908). */
  const admit = Effect.fn("MachineExec.admit")(function* (from: MachineId, input: ExecRequest) {
    const desired = yield* state.activeDesired;
    const self = desired?.self;
    const wanted = input.machine.trim().toLowerCase();
    if (self === undefined || (input.machine !== self.id && self.name.toLowerCase() !== wanted)) {
      // MM-1904: a machine never lends its own arrows onward.
      const reason = "machine_exec from another machine runs only on the machine it calls.";
      if (self !== undefined) yield* reportRefused({ from, input, reason });
      return yield* denied(reason);
    }
    const arrow = yield* allowedNow(from);
    if (arrow === undefined) {
      const reason = `The arrow into ${self.name} does not allow exec now. It needs exec, agent tools and the level standard or admin, and no emergency pause.`;
      yield* reportRefused({ from, input, reason });
      return yield* denied(reason);
    }
    const cwd = path.resolve(
      yield* expandHomePath(input.cwd ?? "~").pipe(Effect.provideService(Path.Path, path)),
    );
    const startedAt = yield* Clock.currentTimeMillis;
    const report = Effect.fn("MachineExec.report")(function* (
      outcome: MachineExecOutcome,
      exitCode: number | null,
    ) {
      const endedAt = yield* Clock.currentTimeMillis;
      yield* machineMap.reportExec({
        id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
        at: DateTime.formatIso(DateTime.makeUnsafe(startedAt)),
        from,
        threadId: input.caller?.threadId ?? null,
        threadTitle: input.caller?.threadTitle ?? null,
        command: input.command.slice(0, REPORTED_COMMAND_CHARS),
        cwd,
        outcome,
        exitCode,
        durationMs: Math.max(0, endedAt - startedAt),
      });
      return endedAt - startedAt;
    });
    const isDirectory = yield* fileSystem.stat(cwd).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    if (!isDirectory) {
      yield* report("failed", null);
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `${cwd} is not a directory on ${self.name}.`,
      });
    }
    const shell = shellFor(yield* HostProcess.Platform, yield* HostProcess.Environment);
    return { self, arrow, cwd, shell, report };
  });

  const runHere = Effect.fn("MachineExec.runHere")(function* (
    from: MachineId,
    input: MachineExecInput,
  ) {
    const { self, arrow, cwd, shell, report } = yield* admit(from, input);
    const run = processRunner
      .run({
        command: shell.command,
        args: [...shell.args, input.command],
        // Known limit: stdin stays open, so a command that reads it waits for the timeout. An
        // empty stdin write races a command that exits first. Revisit when ProcessRunner can
        // spawn with stdin closed.
        cwd,
        timeout: Duration.seconds(input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS),
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: MACHINE_EXEC_MAX_OUTPUT_BYTES,
        outputMode: "truncate",
        truncatedMarker: TRUNCATED_MARKER,
      })
      .pipe(Effect.map((output) => ({ _tag: "ran" as const, output })));
    const stop = lostAccess(from, arrow.expiresAt).pipe(Effect.as({ _tag: "stopped" as const }));
    const ended = yield* Effect.raceFirst(run, stop).pipe(
      // A caller that goes away ends the run too; History still lists it.
      Effect.onInterrupt(() => report("stopped", null)),
      Effect.catch((error) =>
        report("failed", null).pipe(
          Effect.andThen(
            Effect.fail(
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: `${self.name} could not run the command: ${error.message}`,
              }),
            ),
          ),
        ),
      ),
    );
    if (ended._tag === "stopped") {
      yield* report("stopped", null);
      return yield* denied(
        `${self.name} stopped the command: the arrow no longer allows exec, or the owner paused the map.`,
      );
    }
    const { output } = ended;
    const outcome = output.timedOut ? "timedOut" : "exited";
    const durationMs = yield* report(outcome, output.code);
    return {
      machine: self.name,
      cwd,
      shell: shell.command,
      outcome,
      exitCode: output.code,
      stdout: output.stdout,
      stderr: output.stderr,
      stdoutTruncated: output.stdoutTruncated,
      stderrTruncated: output.stderrTruncated,
      durationMs,
    } satisfies MachineExecResult;
  });

  /**
   * MM-1919: runs a stream's command here. Each send waits for the network, so a slow reader slows
   * the command instead of filling memory. The run ends at its timeout, when the arrow stops
   * allowing exec (MM-1916), or when the caller goes away. The History gets one entry at the end,
   * never the output (MM-1908).
   */
  const runStreamHere = Effect.fn("MachineExec.runStreamHere")(function* (
    from: MachineId,
    input: MachineExecStreamStart,
    client: ExecSocket,
  ) {
    const { self, arrow, cwd, shell, report } = yield* admit(from, input);
    const liveness = yield* makeLiveness;
    const stopped = (message: string): StreamEnd => ({ _tag: "stopped", message });
    const timedOut: StreamEnd = { _tag: "timedOut" };
    const ended = yield* Effect.scoped(
      Effect.gen(function* () {
        const stdin = yield* Queue.bounded<Uint8Array, Cause.Done>(STDIN_CHUNKS);
        const child = yield* spawner.spawn(
          ChildProcess.make(shell.command, [...shell.args, input.command], {
            cwd,
            stdin: Stream.fromQueue(stdin),
            forceKillAfter: FORCE_KILL_AFTER,
          }),
        );
        const sendAll = (output: typeof child.stdout, channel: MachineExecStreamChannel) =>
          Stream.runForEach(output, (bytes) => client.send(dataFrame(channel, bytes)));
        const exited = Effect.all(
          [
            sendAll(child.stdout, MachineExecStreamChannel.stdout),
            sendAll(child.stderr, MachineExecStreamChannel.stderr),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.andThen(
            child.exitCode.pipe(
              // The spawner fails `exitCode` for a command that a signal ended. It ran, so it
              // ends as `exited` without a code, never as a command that did not start.
              Effect.orElseSucceed(() => null),
              // Like ssh, a background job of a command that exits 0 or ends by a signal outlives
              // the run: an unref child skips the process group kill when the scope closes. The
              // spawner still ends the group of a command that exits with another code.
              Effect.tap(() => child.unref),
            ),
          ),
          Effect.map((exitCode): StreamEnd => ({ _tag: "exited", exitCode })),
        );
        const fromCaller = Effect.gen(function* () {
          while (true) {
            const frames = yield* client.pull;
            yield* liveness.touch;
            for (const raw of frames) {
              const frame = readFrame(raw);
              if (frame._tag === "data" && frame.channel === MachineExecStreamChannel.stdin) {
                // A command that does not read its stdin holds the caller here, on purpose. Known
                // limit: the silence check pauses meanwhile, so a caller that vanishes without a
                // TCP close leaves such a command running until its timeout or a lost arrow.
                // Revisit if that happens: race the offer against the close of the socket.
                yield* liveness.whileWaitingHere(Queue.offer(stdin, frame.bytes));
              } else if (frame._tag === "message" && frame.message.type === "eof") {
                yield* Queue.end(stdin);
              }
            }
          }
        });
        const timeoutSeconds = input.timeoutSeconds;
        return yield* Effect.raceAllFirst([
          exited,
          fromCaller,
          liveness
            .watch(client.message({ type: "ping" }))
            .pipe(Effect.as(stopped("The caller stopped answering."))),
          timeoutSeconds === undefined
            ? Effect.never
            : Effect.sleep(Duration.seconds(timeoutSeconds)).pipe(Effect.as(timedOut)),
          lostAccess(from, arrow.expiresAt).pipe(
            Effect.as(
              stopped(
                `${self.name} stopped the command: the arrow no longer allows exec, or the owner paused the map.`,
              ),
            ),
          ),
        ]);
      }),
    ).pipe(
      Effect.catch((error): Effect.Effect<StreamEnd> =>
        Effect.succeed(
          // A socket that failed means that the caller went away: no frame reaches it any more.
          error._tag === "SocketError"
            ? stopped("The caller went away.")
            : {
                _tag: "failed",
                message: `${self.name} could not run the command: ${error.message}`,
              },
        ),
      ),
      Effect.onInterrupt(() => report("stopped", null)),
    );
    switch (ended._tag) {
      case "exited":
        yield* report("exited", ended.exitCode);
        return yield* client.message({
          type: "exit",
          outcome: "exited",
          exitCode: ended.exitCode,
          ...(ended.exitCode === null ? { message: "A signal ended the command." } : {}),
        });
      case "timedOut":
        yield* report("timedOut", null);
        return yield* client.message({ type: "exit", outcome: "timedOut", exitCode: null });
      case "stopped":
        yield* report("stopped", null);
        return yield* client.message({
          type: "exit",
          outcome: "stopped",
          exitCode: null,
          message: ended.message,
        });
      case "failed":
        yield* report("failed", null);
        return yield* client.message({ type: "error", message: ended.message });
    }
  });

  /**
   * MM-1902: the source sends its thread's limits in `T3-Mode-Limit`. Exec runs past every T3
   * mode, so a narrower thread there gets no shell here, whatever the arrow allows. A source from
   * before `T3-Mode-Limit` checks the thread itself and sends no header.
   */
  const refuseNarrowedSource = Effect.fn("MachineExec.refuseNarrowedSource")(function* (
    from: MachineId,
    input: ExecRequest,
  ) {
    const narrowed = (yield* McpInvocationContext.McpInvocationContext).client?.narrowedTo;
    if (
      narrowed !== undefined &&
      (narrowed.runtimeMode !== "full-access" || narrowed.interactionMode !== "default")
    ) {
      const reason =
        "machine_exec needs a full-access/default calling thread on the machine that sends it.";
      yield* reportRefused({ from, input, reason });
      return yield* denied(reason);
    }
  });

  /** A refusal on this machine never reaches the other machine, so this machine reports it. */
  const reportOutgoingRefusal = (input: ExecRequest) =>
    Effect.fn("MachineExec.reportOutgoingRefusal")(function* (
      error: MachinePeers.MachinePeerError | OrchestratorMcpFailure,
    ) {
      const target =
        error._tag === "MachinePeerError" &&
        (error.reason === "caller-refused" || error.reason === "no-exec")
          ? error.target
          : undefined;
      const self = (yield* state.activeDesired)?.self;
      if (target === undefined || self === undefined) return;
      yield* reportRefused({
        from: self.id,
        target,
        input: { ...input, caller: yield* historyCaller() },
        reason: error.message,
      });
    });

  const exec: MachineExec["Service"]["exec"] = Effect.fn("MachineExec.exec")(function* (input) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const from = machineOfRequestNamespace(scope.requestNamespace);
    // A local agent goes out through the arrow of this machine; a machine session runs here.
    if (from !== undefined) {
      yield* refuseNarrowedSource(from, input);
      return yield* runHere(from, input);
    }
    return yield* peers.exec(input).pipe(Effect.tapError(reportOutgoingRefusal(input)));
  });

  const stream: MachineExec["Service"]["stream"] = Effect.fn("MachineExec.stream")(
    function* (client) {
      const first = yield* client.pull;
      const [head, ...rest] = first;
      const frame = head === undefined ? undefined : readFrame(head);
      if (frame?._tag !== "message" || frame.message.type !== "start") {
        return yield* client.message({
          type: "error",
          message: "A machine exec stream starts with a start frame.",
        });
      }
      const start = frame.message;
      // Frames that came with the start, such as the first stdin, go first.
      let pending: ReadonlyArray<Uint8Array | string> = rest;
      const caller: ExecSocket = {
        ...client,
        pull: Effect.suspend(() => {
          if (pending.length === 0) return client.pull;
          const frames = pending;
          pending = [];
          return Effect.succeed(frames);
        }),
      };
      const from = machineOfRequestNamespace(
        (yield* McpInvocationContext.McpInvocationContext).requestNamespace,
      );
      if (from !== undefined) {
        yield* refuseNarrowedSource(from, start);
        return yield* runStreamHere(from, start, caller);
      }
      const peer = yield* peers.openExec(start).pipe(Effect.tapError(reportOutgoingRefusal(start)));
      // This machine passes every frame on as it is. The target keeps the stream alive and ends it.
      const passOn = (source: ExecSocket, sink: ExecSocket) =>
        Effect.forever(
          source.pull.pipe(
            Effect.flatMap((frames) => Effect.forEach(frames, sink.send, { discard: true })),
          ),
        );
      yield* Effect.raceFirst(passOn(caller, peer), passOn(peer, caller)).pipe(Effect.ignore);
    },
    (effect, client) =>
      effect.pipe(
        Effect.catch((error) =>
          client.message({ type: "error", message: error.message }).pipe(Effect.ignore),
        ),
        Effect.ensuring(client.close),
      ),
  );

  return MachineExec.of({ exec, stream });
});

export const layer = Layer.effect(MachineExec, make);
