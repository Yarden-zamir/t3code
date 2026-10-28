import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "delegated-work-fork" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:delegated-work-fork"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const send = (
  threadId: ThreadId,
  text: string,
  fields: Pick<MessageDispatch, "createdBy" | "creationSource" | "dispatchMode"> &
    Partial<Pick<MessageDispatch, "notification" | "senderThreadId" | "delegatedCompletion">>,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const messageId = MessageId.make(`message:${threadId}:${text}`);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId,
      text,
      attachments: [],
      ...fields,
    });
    return messageId;
  });

const userSend = (threadId: ThreadId, text: string) =>
  send(threadId, text, {
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "start_immediately" },
  });

const runStates = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`);
  });

const applier = (name: string) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    let sequence = 0;
    return (event: Omit<OrchestrationV2DomainEvent, "id">) =>
      projections.apply({
        ...event,
        id: EventId.make(`event:${name}:${sequence++}`),
      } as OrchestrationV2DomainEvent);
  });

/** Ends a run with a provider failure, as a provider error item and turn end record it. */
const failRun = (threadId: ThreadId, runIndex: number, name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const apply = yield* applier(name);
    const now = yield* DateTime.now;
    const failed = (yield* orchestrator.getThreadProjection(threadId)).runs[runIndex];
    assert.isDefined(failed);
    if (failed === undefined) return;
    yield* apply({
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`item:${name}:error`),
        type: "error",
        threadId,
        runId: failed.id,
        nodeId: failed.rootNodeId,
        providerThreadId: failed.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 100 + runIndex,
        status: "failed",
        title: "Provider failure",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        failure: {
          class: "transport_error",
          message: "Connection refused.",
          code: "econnrefused",
          retryable: null,
        },
      },
    });
    yield* apply({
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: { ...failed, status: "failed", startedAt: now, completedAt: now },
    });
  });

const holdRun = (threadId: ThreadId, runIndex: number, name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const apply = yield* applier(name);
    const now = yield* DateTime.now;
    const queued = (yield* orchestrator.getThreadProjection(threadId)).runs[runIndex];
    assert.equal(queued?.status, "queued");
    if (queued === undefined) return;
    yield* apply({
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: { ...queued, queueHeld: true },
    });
  });

/** Ends the first run with a provider failure and holds the second, as turn end does. */
const failWithHeldQueue = (threadId: ThreadId, name: string) =>
  Effect.gen(function* () {
    yield* failRun(threadId, 0, `${name}:fail`);
    yield* holdRun(threadId, 1, `${name}:hold`);
  });

const agentSend = (threadId: ThreadId, text: string) =>
  send(threadId, text, {
    createdBy: "agent",
    creationSource: "mcp",
    dispatchMode: { type: "queue_after_active" },
  });

it.effect.each([
  [
    "an agent message",
    {
      createdBy: "agent",
      creationSource: "mcp",
      dispatchMode: { type: "queue_after_active" },
    },
  ],
  [
    "a background command wake",
    {
      createdBy: "agent",
      creationSource: "provider",
      dispatchMode: { type: "queue_after_active" },
      notification: {
        source: { kind: "command" },
        outcome: "completed",
        summary: "Command finished",
      },
    },
  ],
] as const)(
  "a message held after a provider failure runs before %s that arrives later",
  ([name, fields]) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(`thread:failure-hold:${name}`);
      yield* createThread(threadId);
      yield* userSend(threadId, "active");
      yield* send(threadId, "queued by the parent", {
        createdBy: "agent",
        creationSource: "mcp",
        dispatchMode: { type: "queue_after_active" },
      });
      yield* failWithHeldQueue(threadId, `failure-hold:${name}`);
      assert.deepEqual(yield* runStates(threadId), ["failed", "queued:held"]);

      yield* send(threadId, "later", fields);

      // The held message starts first; the later one waits behind it, not held.
      assert.deepEqual(yield* runStates(threadId), ["failed", "starting", "queued"]);
    }).pipe(Effect.provide(layerTest)),
);

// "Recreate on a new branch" resends the failed message as the user who clicked.
it.effect("a message the user resends from a client starts before the held queue", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:failure-hold:user-resend");
    yield* createThread(threadId);
    yield* userSend(threadId, "active");
    yield* agentSend(threadId, "queued by the parent");
    yield* failWithHeldQueue(threadId, "failure-hold:user-resend");

    yield* send(threadId, "resent", {
      createdBy: "user",
      creationSource: "mobile",
      dispatchMode: { type: "queue_after_active" },
    });

    assert.deepEqual(yield* runStates(threadId), ["failed", "queued", "starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a message held after a usage limit stays held behind an agent message", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:failure-hold:usage-limit");
    yield* createThread(threadId);
    yield* userSend(threadId, "active");
    yield* send(threadId, "queued", {
      createdBy: "agent",
      creationSource: "mcp",
      dispatchMode: { type: "queue_after_active" },
    });
    yield* failWithHeldQueue(threadId, "failure-hold:usage-limit-failure");
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const apply = yield* applier("failure-hold:usage-limit");
    const now = yield* DateTime.now;
    const error = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
      (item) => item.type === "error",
    );
    assert.equal(error?.type, "error");
    if (error?.type !== "error") return;
    yield* apply({
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: { ...error, failure: { ...error.failure, class: "usage_limit" } },
    });

    yield* send(threadId, "later", {
      createdBy: "agent",
      creationSource: "mcp",
      dispatchMode: { type: "queue_after_active" },
    });

    assert.deepEqual(yield* runStates(threadId), ["failed", "queued:held", "starting"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a Stop hold stays held when a wake that started ahead of it fails", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:failure-hold:stop");
    yield* createThread(threadId);
    yield* userSend(threadId, "active");
    yield* agentSend(threadId, "queued before the stop");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop:failure-hold"),
      threadId,
    });
    assert.deepEqual(yield* runStates(threadId), ["interrupted", "queued:held"]);
    // Upstream: an agent's message starts on the stopped thread; the hold is the user's.
    yield* agentSend(threadId, "wake");
    yield* failRun(threadId, 2, "failure-hold:stop:wake");

    yield* agentSend(threadId, "next wake");

    assert.deepEqual(yield* runStates(threadId), [
      "interrupted",
      "queued:held",
      "failed",
      "starting",
    ]);
  }).pipe(Effect.provide(layerTest)),
);

/**
 * A parent with one delegated child whose original task already reported its
 * result. The parent's turn ended, so a later delivery opens a new generation.
 */
const delegatedChildWithResult = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentThreadId = ThreadId.make(`thread:later-run-parent:${name}`);
    yield* createThread(parentThreadId);
    yield* userSend(parentThreadId, "parent");
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${name}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: `original task ${name}`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const original = parent.subagents[0]!;
    const childThreadId = original.childThreadId!;
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    const apply = yield* applier(`later-run:${name}`);
    const now = yield* DateTime.now;
    yield* apply({
      type: "run.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: { ...child.runs[0]!, status: "completed", startedAt: now, completedAt: now },
    });
    yield* apply({
      type: "subagent.updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: {
        ...original,
        status: "completed",
        result: "Interim result",
        completedAt: now,
        completionDelivery: { state: "acknowledged", observedByRunId: parent.runs[0]!.id },
      },
    });
    yield* apply({
      type: "context-transfer.created",
      threadId: parentThreadId,
      occurredAt: now,
      payload: {
        ...child.contextTransfers[0]!,
        id: ContextTransferId.make(`transfer:original-result:${name}`),
        type: "subagent_result",
        sourceThreadId: childThreadId,
        targetThreadId: parentThreadId,
        sourcePoint: { threadId: childThreadId, runId: child.runs[0]!.id },
        targetRunId: parent.runs[0]!.id,
      },
    });
    yield* apply({
      type: "run.updated",
      threadId: parentThreadId,
      occurredAt: now,
      payload: { ...parent.runs[0]!, status: "completed", completedAt: now },
    });
    return { parentThreadId, childThreadId, originalId: original.id, apply, now };
  });

const nestedDelegatedCompletion = (childThreadId: ThreadId, name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const apply = yield* applier(`nested:${name}`);
    const now = yield* DateTime.now;
    const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
    const grandchildTaskId = NodeId.make(`node:grandchild:${name}`);
    const messageId = MessageId.make(`message:nested-completion:${name}`);
    yield* apply({
      type: "subagent.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: {
        id: grandchildTaskId,
        threadId: childThreadId,
        runId: childRun.id,
        parentNodeId: childRun.rootNodeId!,
        origin: "app_owned",
        createdBy: "agent",
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerThreadId: null,
        childThreadId: ThreadId.make(`thread:grandchild:${name}`),
        nativeTaskRef: null,
        prompt: "Review the change.",
        title: "Review",
        model: null,
        completionWake: "always",
        completionDelivery: { state: "claimed", observedByRunId: null },
        status: "completed",
        result: "Review done",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      },
    });
    yield* apply({
      type: "run.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: {
        ...childRun,
        delegatedCompletion: {
          disposition: "open",
          nextGeneration: 2,
          delivery: { generation: 1, messageId, taskIds: [grandchildTaskId] },
        },
      },
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`nested-completion:${name}`),
      threadId: childThreadId,
      messageId,
      text: "Your delegated task finished.",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
      delegatedCompletion: {
        parentRunId: childRun.id,
        generation: 1,
        taskIds: [grandchildTaskId],
      },
    });
    return messageId;
  });

// The third is t3_worktree_handoff with threadId: the lead restarts a delegate in a new worktree.
it.effect.each(["a background command", "a nested delegated task", "the lead's continuation"])(
  "a delegated child's later run from %s reaches the parent once, as its own task",
  (source) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { parentThreadId, childThreadId, originalId, apply, now } =
        yield* delegatedChildWithResult(source);
      const originalBefore = (yield* orchestrator.getThreadProjection(
        parentThreadId,
      )).subagents.find((task) => task.id === originalId);

      const messageId =
        source === "a background command"
          ? yield* send(childThreadId, "background command finished", {
              createdBy: "agent",
              creationSource: "provider",
              dispatchMode: { type: "queue_after_active" },
              notification: {
                source: { kind: "command" },
                outcome: "completed",
                summary: "Command finished",
              },
            })
          : source === "a nested delegated task"
            ? yield* nestedDelegatedCompletion(childThreadId, source)
            : yield* send(childThreadId, "continue in the new worktree", {
                createdBy: "agent",
                creationSource: "mcp",
                dispatchMode: { type: "queue_after_active" },
                senderThreadId: parentThreadId,
              });

      const wakeRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs.find(
        (run) => run.userMessageId === messageId,
      );
      assert.isDefined(wakeRun?.delegatedTaskId);
      if (wakeRun?.delegatedTaskId === undefined) return;
      yield* apply({
        type: "run.updated",
        threadId: childThreadId,
        occurredAt: now,
        payload: { ...wakeRun, status: "completed", startedAt: now, completedAt: now },
      });
      yield* orchestrator.recoverDelegatedTasks;
      yield* orchestrator.recoverDelegatedTasks;

      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const followup = parent.subagents.find((task) => task.id === wakeRun.delegatedTaskId);
      assert.equal(followup?.status, "completed");
      assert.equal(followup?.completionDelivery?.state, "claimed");
      assert.deepEqual(parent.runs[0]?.delegatedCompletion?.delivery?.taskIds, [
        wakeRun.delegatedTaskId,
      ]);
      assert.equal(
        parent.contextTransfers.filter(
          (transfer) =>
            transfer.type === "subagent_result" && transfer.sourceThreadId === childThreadId,
        ).length,
        2,
      );
      assert.deepEqual(
        parent.subagents.find((task) => task.id === originalId),
        originalBefore,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("a delegated child's own wake does not report to a parent that cancelled it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parentThreadId, childThreadId, originalId } =
      yield* delegatedChildWithResult("cancelled");
    // What task_cancel dispatches.
    yield* orchestrator.dispatch({
      type: "delegated_task.completion-delivery.dispose",
      commandId: CommandId.make("cancel:dispose"),
      parentThreadId,
      taskId: originalId,
    });
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("cancel:stop"),
      threadId: childThreadId,
      stopDelegatedTasks: false,
    });

    const wake = yield* send(childThreadId, "background command finished", {
      createdBy: "agent",
      creationSource: "provider",
      dispatchMode: { type: "queue_after_active" },
      notification: { source: { kind: "command" }, outcome: "completed", summary: "Done" },
    });
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    assert.isUndefined(child.runs.find((run) => run.userMessageId === wake)?.delegatedTaskId);
    assert.lengthOf((yield* orchestrator.getThreadProjection(parentThreadId)).subagents, 1);
  }).pipe(Effect.provide(layerTest)),
);
