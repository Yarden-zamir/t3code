import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  TERMINAL_THREAD_INSTANCE_ID,
  TERMINAL_THREAD_MODEL_SELECTION,
  type TerminalShellState,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { makeTerminalAdapter } from "./adapter.ts";
import type { TerminalPort, TerminalPortEvent } from "./port.ts";
import { BUSY_SHELL_MESSAGE, pastedCommand, TERMINAL_RUN_TIMEOUT_MS } from "./protocol.ts";

const PROMPT = "\u001b]133;A\u0007";
const threadId = ThreadId.make("thread:terminal-adapter");
const runId = RunId.make("run:terminal-adapter");
const attemptId = RunAttemptId.make("attempt:terminal-adapter");
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/repo",
});

/** A live shell whose program the test ends by printing the shell's marks. */
const makeFakePort = Effect.gen(function* () {
  let state: TerminalShellState | undefined = "running";
  const listeners = new Set<(event: TerminalPortEvent) => Effect.Effect<void>>();
  const subscribed = yield* Queue.unbounded<void>();
  const writes = yield* Queue.unbounded<string>();
  const port: TerminalPort["Service"] = {
    isRunning: () => Effect.succeed(true),
    shellState: () => Effect.sync(() => state),
    workspaceRootOf: () => Effect.succeed("/repo"),
    open: () => Effect.die("A running terminal is never opened again."),
    write: (input) => Queue.offer(writes, input.data).pipe(Effect.asVoid),
    subscribe: (_ids, listener) =>
      Effect.sync(() => listeners.add(listener)).pipe(
        Effect.andThen(Queue.offer(subscribed, undefined)),
        Effect.as(() => {
          listeners.delete(listener);
        }),
      ),
  };
  const print = (data: string, next: TerminalShellState) =>
    Effect.gen(function* () {
      state = next;
      for (const listener of listeners) yield* listener({ type: "output", data });
    });
  return { port, subscribed, writes, print };
});

const startRun = (fake: Effect.Success<typeof makeFakePort>, text: string) =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const adapter = makeTerminalAdapter({
      instanceId: TERMINAL_THREAD_INSTANCE_ID,
      idAllocator,
      port: fake.port,
      ensureEnabled: Effect.void,
      workspaceRootOf: () => Effect.succeed("/repo"),
    });
    const modelSelection = TERMINAL_THREAD_MODEL_SELECTION;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("session:terminal-adapter"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    yield* runtime.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:terminal-adapter"),
        title: "Terminal",
        providerInstanceId: TERMINAL_THREAD_INSTANCE_ID,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId,
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId,
      rootNodeId: NodeId.make("node:terminal-adapter"),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("message:terminal-adapter"),
        text,
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });
    // The first look at the shell, then the wait for its prompt.
    yield* Queue.take(fake.subscribed);
    yield* Queue.take(fake.subscribed);
    const outcome = runtime.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
      Effect.map((events) => {
        const terminal = events.find((event) => event.type === "turn.terminal");
        const answer = events.find((event) => event.type === "message.updated");
        return {
          terminal: terminal?.type === "turn.terminal" ? terminal : undefined,
          answer: answer?.type === "message.updated" ? answer.message.text : undefined,
        };
      }),
    );
    const steer = (steerText: string) =>
      runtime.steerTurn({
        threadId,
        runId,
        providerThread,
        providerTurnId: idAllocator.derive.providerTurn({
          driver: adapter.driver,
          nativeTurnId: `${runId}:${attemptId}`,
        }),
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make(`message:${steerText}`),
          text: steerText,
          attachments: [],
        },
      });
    return { outcome, steer };
  });

const completeAtPrompt = (fake: Effect.Success<typeof makeFakePort>, text: string) =>
  Effect.gen(function* () {
    yield* fake.print(PROMPT, "prompt");
    assert.equal(yield* Queue.take(fake.writes), pastedCommand(text));
    yield* fake.print("\u001b]133;C\u0007done\r\n\u001b]133;D;0\u0007", "prompt");
  });

it.effect("a message waits while a program runs, then runs at the prompt", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakePort;
    const run = yield* startRun(fake, "ls");
    assert.equal(yield* Queue.size(fake.writes), 0);

    yield* completeAtPrompt(fake, "ls");

    const { terminal, answer } = yield* run.outcome;
    assert.equal(terminal?.status, "completed");
    assert.include(answer ?? "", "Exit code 0.");
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("a steer during the wait types into the program at once", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakePort;
    const run = yield* startRun(fake, "ls");

    yield* run.steer(":wq");
    assert.equal(yield* Queue.take(fake.writes), ":wq\r");

    yield* completeAtPrompt(fake, "ls");
    assert.equal((yield* run.outcome).terminal?.status, "completed");
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);

it.effect("a program that holds the shell for the whole run fails the run", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakePort;
    const run = yield* startRun(fake, "ls");

    yield* TestClock.adjust(TERMINAL_RUN_TIMEOUT_MS);

    const { terminal } = yield* run.outcome;
    assert.equal(terminal?.status, "failed");
    assert.equal(terminal?.failure?.message, BUSY_SHELL_MESSAGE);
    assert.equal(yield* Queue.size(fake.writes), 0);
  }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
);
