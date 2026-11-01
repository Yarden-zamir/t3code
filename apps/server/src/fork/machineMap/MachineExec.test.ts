import type { Answer } from "@kitshn/local";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MACHINE_EXEC_MAX_OUTPUT_BYTES,
  MachineExecStreamChannel,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as KitshnConnection from "../kitshn/KitshnConnection.ts";
import { registerAnswer } from "../kitshn/KitshnConnection.testkit.ts";
import * as KitshnProvider from "../kitshn/KitshnProvider.ts";
import { machineRequestNamespace } from "./machineAccess.ts";
import * as MachineExec from "./MachineExec.ts";
import { dataFrame, type ExecSocket, readFrame } from "./machineExecStream.ts";
import { PEER } from "./MachineMap.testkit.ts";

const threadId = ThreadId.make("thread:exec-caller");
const localThread: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mac"),
  requestNamespace: "provider:exec-caller",
  thread: {
    threadId,
    providerSessionId: "provider:exec-caller",
    providerInstanceId: ProviderInstanceId.make("codex"),
    authorization: Redacted.make("Bearer thread-token"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 0,
};
const peerSession: McpInvocationContext.McpInvocationScope = {
  ...localThread,
  requestNamespace: machineRequestNamespace({ machineId: PEER, sessionId: "session-1" }),
  thread: undefined,
  client: { sessionId: "session-1", label: "machine VPS", access: "full-access" },
};

const EXEC_ID = "e-1";
const base64 = (text: string | Uint8Array) => Buffer.from(text).toString("base64");
const output = (stream: "stdout" | "stderr", text: string | Uint8Array) =>
  ({ type: "exec-output", execId: EXEC_ID, stream, data: base64(text) }) as const;
const exit = (fields: {
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly reason?: string | null;
}) =>
  ({
    type: "exec-exit",
    execId: EXEC_ID,
    exitCode: fields.exitCode ?? null,
    signal: fields.signal ?? null,
    durationMs: 812,
    reason: fields.reason ?? null,
  }) as const;

type Script = {
  readonly state: "running" | "waiting" | "ended";
  /** The frames that the daemon sends right after its answer to `exec`. */
  readonly frames: ReadonlyArray<KitshnConnection.DaemonEvent>;
  /** The frames that it sends once the stdin of the run ended. */
  readonly afterStdin?: ReadonlyArray<KitshnConnection.DaemonEvent>;
  /** It refuses each chunk of stdin. */
  readonly refusesStdin?: boolean;
};

/** A daemon that runs the script of each `exec`, and records the requests and the notices. */
const harness = Effect.fn("MachineExecTest.harness")(function* (script: Script) {
  const requests = yield* Queue.unbounded<KitshnConnection.LocalRequestInput>();
  const notices = yield* Queue.unbounded<KitshnConnection.Notice>();
  const connection = yield* KitshnConnection.make;
  yield* connection.attach({
    answer: registerAnswer(),
    request: (input) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, input);
        if (input.type === "exec-close") {
          for (const frame of script.afterStdin ?? []) yield* connection.publish(frame);
        }
        if (input.type === "exec-input" && script.refusesStdin === true) {
          return { id: "x", type: "error", error: "stdin refused" } satisfies Answer;
        }
        if (input.type !== "exec") return { id: "x", type: input.type } as Answer;
        for (const frame of script.frames) yield* connection.publish(frame);
        return {
          id: "x",
          type: "exec",
          execId: EXEC_ID,
          state: script.state,
          ...(script.state === "waiting" ? { proposalId: "p-1" } : {}),
        } satisfies Answer;
      }),
    notify: (notice) => Queue.offer(notices, notice).pipe(Effect.asVoid),
  });
  const layer = MachineExec.layer.pipe(
    Layer.provide(Layer.succeed(KitshnConnection.KitshnConnection, connection)),
    Layer.provide(
      Layer.mock(KitshnProvider.KitshnProvider)({
        state: Stream.make({
          settings: null,
          cardSettings: {},
          reach: [
            {
              machineId: PEER,
              machineName: "VPS",
              kind: "t3.app",
              id: "app",
              address: "t3-vps.example.com",
              level: "use",
            },
          ],
          syncedAt: 0,
          paused: false,
          problems: [],
        }),
      }),
    ),
  );
  // Built in the test's scope: a run that waits for the owner goes on after its call.
  const machineExec = Context.get(yield* Layer.build(layer), MachineExec.MachineExec);
  const caller = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      McpInvocationContext.McpInvocationContext | ThreadManagement.ThreadManagementService
    >,
    scope: McpInvocationContext.McpInvocationScope = localThread,
    modes: Parameters<typeof liveThreadShell>[1] = {},
  ) =>
    effect.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId, modes)),
        }),
      ),
    );
  return { machineExec, connection, requests, notices, caller };
});

it.effect("runs a command through kitshn as the calling thread (K-722)", () =>
  Effect.gen(function* () {
    const test = yield* harness({
      state: "running",
      frames: [output("stdout", "hi\n"), output("stderr", "warn\n"), exit({ exitCode: 3 })],
    });
    const result = yield* test.caller(
      test.machineExec.exec({ machine: "vps", command: "git status", cwd: "~/x" }),
    );
    expect(result).toEqual({
      machine: "VPS",
      outcome: "exited",
      exitCode: 3,
      signal: null,
      stdout: "hi\n",
      stderr: "warn\n",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 812,
    });
    expect(yield* Queue.take(test.requests)).toEqual({
      type: "exec",
      target: PEER,
      command: "git status",
      cwd: "~/x",
      timeoutSeconds: 30,
      stdin: false,
      attest: "t3:thread-token",
    });
  }),
);

it.effect("keeps 50,000 bytes of a stream, marks the cut and gives the credit back", () =>
  Effect.gen(function* () {
    const big = new Uint8Array(16 * 1024).fill(97);
    const test = yield* harness({
      state: "running",
      frames: [...Array.from({ length: 20 }, () => output("stdout", big)), exit({ exitCode: 0 })],
    });
    const result = yield* test.caller(test.machineExec.exec({ machine: "VPS", command: "yes" }));
    if (result.outcome === "waiting") return yield* Effect.die("not waiting");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.startsWith("a".repeat(MACHINE_EXEC_MAX_OUTPUT_BYTES))).toBe(true);
    expect(result.stdout.slice(MACHINE_EXEC_MAX_OUTPUT_BYTES)).toContain("[output truncated");
    // 320 KiB read: one grant of at least 256 KiB, after the data was taken.
    const credit = yield* Queue.take(test.notices);
    expect(credit).toMatchObject({ type: "exec-credit", execId: EXEC_ID });
    expect(credit.type === "exec-credit" && credit.bytes >= 256 * 1024).toBe(true);
  }),
);

it.effect("reports a timeout, and fails with kitshn's reason for a run that never ran", () =>
  Effect.gen(function* () {
    const timedOut = yield* harness({
      state: "running",
      frames: [exit({ signal: "SIGKILL", reason: "timed out after 30 s" })],
    });
    const result = yield* timedOut.caller(
      timedOut.machineExec.exec({ machine: "VPS", command: "sleep 99" }),
    );
    expect(result).toMatchObject({ outcome: "timedOut", exitCode: null, signal: "SIGKILL" });

    const refused = yield* harness({
      state: "ended",
      frames: [exit({ reason: 'refused: "runs commands" is off' })],
    });
    const error = yield* refused
      .caller(refused.machineExec.exec({ machine: "VPS", command: "true" }))
      .pipe(Effect.flip);
    expect(error).toMatchObject({ code: "capability_denied" });
    expect(error.message).toContain("runs commands");
  }),
);

it.effect("answers waiting after a minute without approval, and keeps the late result", () =>
  Effect.gen(function* () {
    const test = yield* harness({ state: "waiting", frames: [] });
    const call = yield* test
      .caller(test.machineExec.exec({ machine: "VPS", command: "uptime" }))
      .pipe(Effect.forkChild);
    // The call waits for the owner from the moment its exec request was answered.
    yield* Queue.take(test.requests);
    yield* TestClock.adjust("60 seconds");
    expect(yield* Fiber.join(call)).toMatchObject({
      machine: "VPS",
      outcome: "waiting",
      proposalId: "p-1",
    });
    // The owner approves later; the run streams on the same exec id.
    yield* test.connection.publish(output("stdout", "up 3 days\n"));
    yield* test.connection.publish(exit({ exitCode: 0 }));
    const late = yield* test.machineExec.lateResults.pipe(
      Stream.filter((results) => results.length > 0),
      Stream.runHead,
    );
    expect(Option.getOrThrow(late)).toMatchObject([
      { proposalId: "p-1", result: { outcome: "exited", stdout: "up 3 days\n" } },
    ]);
  }),
);

it.effect("ends a run with 'the relay was lost' when the provider connection drops", () =>
  Effect.gen(function* () {
    const test = yield* harness({ state: "running", frames: [] });
    const call = yield* test
      .caller(test.machineExec.exec({ machine: "VPS", command: "sleep 30" }))
      .pipe(Effect.forkChild);
    yield* Queue.take(test.requests);
    // The daemon kills a run of a closed connection without a last frame.
    yield* test.connection.attach(null);
    const error = yield* Fiber.join(call).pipe(Effect.flip);
    expect(error).toMatchObject({ code: "orchestration_error", message: "the relay was lost" });
  }),
);

it.effect("keeps the output that came before a late approval's call gave up", () =>
  Effect.gen(function* () {
    const test = yield* harness({ state: "waiting", frames: [] });
    const call = yield* test
      .caller(test.machineExec.exec({ machine: "VPS", command: "uptime" }))
      .pipe(Effect.forkChild);
    yield* Queue.take(test.requests);
    yield* test.connection.publish(output("stdout", "early\n"));
    yield* TestClock.adjust("60 seconds");
    expect(yield* Fiber.join(call)).toMatchObject({ outcome: "waiting" });
    yield* test.connection.publish(output("stdout", "late\n"));
    yield* test.connection.publish(exit({ exitCode: 0 }));
    const late = yield* test.machineExec.lateResults.pipe(
      Stream.filter((results) => results.length > 0),
      Stream.runHead,
    );
    expect(Option.getOrThrow(late)).toMatchObject([
      { result: { outcome: "exited", stdout: "early\nlate\n" } },
    ]);
  }),
);

it.effect("refuses restricted callers, other machines and unknown machines before kitshn", () =>
  Effect.gen(function* () {
    const test = yield* harness({ state: "running", frames: [exit({ exitCode: 0 })] });
    for (const modes of [{ runtimeMode: "auto" }, { interactionMode: "plan" }] as const) {
      const error = yield* test
        .caller(test.machineExec.exec({ machine: "VPS", command: "true" }), localThread, modes)
        .pipe(Effect.flip);
      expect(error.message).toContain("full-access/default");
    }
    // MM-1904: a session of another machine never borrows this machine's exec.
    yield* test
      .caller(test.machineExec.exec({ machine: "VPS", command: "true" }), peerSession)
      .pipe(Effect.flip);
    const unknown = yield* test
      .caller(test.machineExec.exec({ machine: "pi", command: "true" }))
      .pipe(Effect.flip);
    expect(unknown.message).toContain("T3 app card");
    expect(yield* Queue.size(test.requests)).toBe(0);
  }),
);

/** A CLI socket: the frames that the CLI sends, and the frames that reach it. */
const cliSocket = Effect.gen(function* () {
  const fromCli = yield* Queue.unbounded<ReadonlyArray<Uint8Array | string>>();
  const toCli = yield* Queue.unbounded<Uint8Array | string>();
  const socket: ExecSocket = {
    pull: Queue.take(fromCli),
    send: (frame) => Queue.offer(toCli, frame).pipe(Effect.asVoid),
    message: (message) => Queue.offer(toCli, JSON.stringify(message)).pipe(Effect.asVoid),
    close: Effect.void,
  };
  return { socket, fromCli, toCli };
});

it.effect(
  "relays a t3 machine exec stream: stdin with its end, output and the exit (MM-1919)",
  () =>
    Effect.gen(function* () {
      const test = yield* harness({
        state: "waiting",
        frames: [],
        afterStdin: [output("stdout", "hello\n"), exit({ exitCode: 0 })],
      });
      const cli = yield* cliSocket;
      yield* Queue.offer(cli.fromCli, [
        JSON.stringify({ type: "start", machine: "VPS", command: "cat" }),
        dataFrame(MachineExecStreamChannel.stdin, new TextEncoder().encode("hello\n")),
        JSON.stringify({ type: "eof" }),
      ]);
      yield* test.caller(Effect.scoped(test.machineExec.stream(cli.socket)));
      const received = (yield* Queue.takeAll(cli.toCli)).map(readFrame);
      expect(received).toEqual([
        { _tag: "message", message: { type: "waiting", proposalId: "p-1" } },
        {
          _tag: "data",
          channel: MachineExecStreamChannel.stdout,
          bytes: new TextEncoder().encode("hello\n"),
        },
        { _tag: "message", message: { type: "exit", outcome: "exited", exitCode: 0 } },
      ]);
      expect(yield* Queue.takeAll(test.requests)).toMatchObject([
        { type: "exec", target: PEER, command: "cat", timeoutSeconds: 3600, stdin: true },
        { type: "exec-input", execId: EXEC_ID, data: base64("hello\n") },
        { type: "exec-close", execId: EXEC_ID, what: "stdin" },
      ]);
    }),
);

it.effect("keeps waiting for the exit after kitshn refuses the stdin of a stream", () =>
  Effect.gen(function* () {
    const test = yield* harness({
      state: "running",
      frames: [],
      refusesStdin: true,
      // The command sees the end of stdin and exits, so the run needs the close below.
      afterStdin: [exit({ exitCode: 1 })],
    });
    const cli = yield* cliSocket;
    yield* Queue.offer(cli.fromCli, [
      JSON.stringify({ type: "start", machine: "VPS", command: "cat" }),
      dataFrame(MachineExecStreamChannel.stdin, new TextEncoder().encode("hello\n")),
      JSON.stringify({ type: "eof" }),
    ]);
    yield* test.caller(Effect.scoped(test.machineExec.stream(cli.socket)));
    const received = (yield* Queue.takeAll(cli.toCli)).map(readFrame);
    expect(received).toEqual([
      { _tag: "message", message: { type: "exit", outcome: "exited", exitCode: 1 } },
    ]);
    // After the refused chunk, stdin ends once, and the later `eof` of the CLI sends nothing.
    expect((yield* Queue.takeAll(test.requests)).map((request) => request.type)).toEqual([
      "exec",
      "exec-input",
      "exec-close",
    ]);
  }),
);
