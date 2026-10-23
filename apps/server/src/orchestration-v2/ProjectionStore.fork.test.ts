import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = modelSelection.instanceId;

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s record reads select subagents by id", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:subagent-by-id");
    yield* store.apply({
      id: EventId.make("event:subagent-by-id:thread-created"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:subagent-by-id"),
        title: "Subagent records",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
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
    });
    const ids = [NodeId.make("node:subagent-by-id:a"), NodeId.make("node:subagent-by-id:b")];
    for (const id of ids) {
      yield* store.apply({
        id: EventId.make(`event:${id}`),
        type: "subagent.updated",
        threadId,
        nodeId: id,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id,
          threadId,
          runId: null,
          parentNodeId: NodeId.make("node:subagent-by-id:parent"),
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Do the work",
          title: "Delegated task",
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
    }
    const read = (subagentIds?: ReadonlyArray<NodeId>) =>
      store
        .getThreadRecords(threadId, ["subagents"], subagentIds === undefined ? {} : { subagentIds })
        .pipe(Effect.map(({ subagents }) => subagents.map((task) => task.id)));
    assert.deepEqual(yield* read(), ids);
    assert.deepEqual(yield* read([ids[1]!]), [ids[1]]);
    assert.deepEqual(yield* read([]), []);
  }).pipe(Effect.provide(layer)),
);
