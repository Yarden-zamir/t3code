/**
 * Fork: machine map, `machine_exec` (MM-1908, MM-1909). An agent of this machine sends the call to
 * another machine through `MachinePeers.exec`. A session of another machine runs the command here,
 * as the user of this server. Only the arrow and the caller limits control a run: no list of
 * commands or patterns grants or refuses one (MM-1909).
 */
import {
  MACHINE_EXEC_MAX_OUTPUT_BYTES,
  type MachineExecInput,
  type MachineExecOutcome,
  type MachineExecResult,
  type MachineId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { historyCaller } from "./machineCallerAccess.ts";
import { expandHomePath } from "../../os-jank.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { execArrowInto, machineOfRequestNamespace } from "./machineAccess.ts";
import * as MachineMap from "./MachineMap.ts";
import * as MachineMapState from "./MachineMapState.ts";
import * as MachinePeers from "./MachinePeers.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
/** The History keeps the start of a long command, so one run cannot fill the portal. */
const REPORTED_COMMAND_CHARS = 2_000;
const TRUNCATED_MARKER = `\n[output truncated at ${MACHINE_EXEC_MAX_OUTPUT_BYTES} bytes]`;

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
  }
>()("t3/fork/machineMap/MachineExec") {}

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
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const allowedNow = (from: MachineId) =>
    Effect.all([state.activeDesired, Clock.currentTimeMillis]).pipe(
      Effect.map(([desired, nowMs]) =>
        desired === null ? undefined : execArrowInto(desired, from, nowMs),
      ),
    );

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
    if (expiresAt === null) return changed;
    const expired = Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMs) => Effect.sleep(Duration.millis(Date.parse(expiresAt) - nowMs))),
      Effect.andThen(allowedNow(from)),
      Effect.flatMap((arrow) => (arrow === undefined ? Effect.void : Effect.never)),
    );
    return Effect.raceFirst(changed, expired);
  };

  /** MM-1908: a refused call in the History. No command ran, so it has no output or exit code. */
  const reportRefused = Effect.fn("MachineExec.reportRefused")(function* (refusal: {
    readonly from: MachineId;
    /** The machine that the command was for, when the calling machine reports its refusal. */
    readonly target?: MachineId;
    readonly input: MachineExecInput;
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

  const runHere = Effect.fn("MachineExec.runHere")(function* (
    from: MachineId,
    input: MachineExecInput,
  ) {
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

  const exec: MachineExec["Service"]["exec"] = Effect.fn("MachineExec.exec")(function* (input) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const from = machineOfRequestNamespace(scope.requestNamespace);
    // A local agent goes out through the arrow of this machine; a machine session runs here.
    if (from !== undefined) return yield* runHere(from, input);
    return yield* peers.exec(input).pipe(
      // A refusal here never reaches the other machine, so this machine reports it.
      Effect.tapError((error) => {
        const target =
          error._tag === "MachinePeerError" &&
          (error.reason === "caller-refused" || error.reason === "no-exec")
            ? error.target
            : undefined;
        return target === undefined
          ? Effect.void
          : Effect.gen(function* () {
              const self = (yield* state.activeDesired)?.self;
              if (self === undefined) return;
              yield* reportRefused({
                from: self.id,
                target,
                input: { ...input, caller: yield* historyCaller() },
                reason: error.message,
              });
            });
      }),
    );
  });

  return MachineExec.of({ exec });
});

export const layer = Layer.effect(MachineExec, make);
