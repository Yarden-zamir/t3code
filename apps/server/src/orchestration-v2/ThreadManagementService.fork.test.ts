import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  TERMINAL_THREAD_INSTANCE_ID,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    // A client cannot claim a linked environment's origin, or a parent there.
    linkOrigin: { sessionId: "forged", label: "Somewhere else" },
    delegatedFrom: {
      environmentId: EnvironmentId.make("environment:elsewhere"),
      threadId: ThreadId.make("thread:elsewhere"),
      title: "Somewhere else",
    },
  };

  const stamped = ThreadManagementService.withCreationProvenance(command, {
    createdBy: "user",
    creationSource: "web",
  });
  expect(stamped).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
  expect(stamped).not.toHaveProperty("linkOrigin");
  expect(stamped).not.toHaveProperty("delegatedFrom");
});

it.effect("waitForThread can wait past an ended run for the thread's delegated work", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-delegated");
    const threadId = ThreadId.make("thread:thread-management:wait-delegated");
    const runId = RunId.make("run:thread-management:wait-delegated");
    const wakeRunId = RunId.make("run:thread-management:wait-delegated:wake");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1_000);
    const run = (id: RunId, ordinal: number, status: OrchestrationV2Run["status"], end: number) =>
      ({
        id,
        ordinal,
        status,
        startedAt: at(end - 1),
        completedAt: status === "running" ? null : at(end),
      }) as unknown as OrchestrationV2Run;
    // The run ended, but a task it delegated still runs and will wake the thread.
    let runs = [run(runId, 1, "completed", 1)];
    let subagents = [{ status: "running" }];
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "subagent.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                  messages: [],
                  subagents,
                  providerThreads: [],
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    // Without the option, the ended run is the answer, as before.
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).toMatchObject({ timedOut: false, run: { id: runId } });
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).not.toHaveProperty("resultRun");

    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60 * 60 * 1_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    // A wait that returns early fails below instead of hanging here.
    yield* Effect.raceFirst(Deferred.await(subscribed), Fiber.await(fiber));
    // The task finishes; its delivery wakes the thread, whose next run answers.
    subagents = [{ status: "completed" }];
    runs = [...runs, run(wakeRunId, 2, "completed", 3)];
    yield* Queue.offer(events, stored(1, { type: "subagent.updated", payload: {} }));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: runId, status: "completed" },
      resultRun: { id: wakeRunId, status: "completed" },
    });
  }),
);

it.effect(
  "refuses a terminal thread for a sender that asks for it, before anything is sent",
  () => {
    const projectId = ProjectId.make("project:thread-management:terminal");
    const threadId = ThreadId.make("thread:thread-management:terminal");
    const projection = {
      thread: {
        id: threadId,
        projectId,
        deletedAt: null,
        archivedAt: null,
        modelSelection: { instanceId: TERMINAL_THREAD_INSTANCE_ID, model: "terminal" },
      },
      runs: [],
      providerTurns: [],
    } as unknown as OrchestrationV2ThreadProjection;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getThreadProjection: () => Effect.succeed(projection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );

    return Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* Effect.flip(
        service.sendToThread({
          projectId,
          commandId: CommandId.make("command:thread-management:terminal"),
          threadId,
          messageId: MessageId.make("message:thread-management:terminal"),
          text: "rm -rf ~",
          attachments: [],
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
          refuseTerminalThread: true,
        }),
      );
      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementTerminalThreadRefusedError,
      );
    }).pipe(Effect.provide(layerTest));
  },
);
