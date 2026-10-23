import { assert, it } from "@effect/vitest";
import { EventId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = EventSink.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
      Layer.provideMerge(SqlitePersistence.layerMemory),
    ),
  ),
);

it.effect("stores a preview tool call with its URL token hidden", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:preview-token");
    const itemId = TurnItemId.make("item:preview-open");
    // A fake token: the real one never enters a test.
    const pairingUrl = "http://127.0.0.1:5733/pair#token=fake-dev-token";

    const [stored] = yield* sink.write({
      events: [
        {
          id: EventId.make("event:preview-open"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: itemId,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: `Open ${pairingUrl}`,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "dynamic_tool",
            toolName: "mcp__t3-code__preview_open",
            input: { url: pairingUrl },
            output: [{ type: "text", text: JSON.stringify({ url: pairingUrl }) }],
          },
        },
      ],
    });

    const persisted = yield* projections.getTurnItem({ threadId, itemId });
    for (const item of [stored?.event.payload, persisted]) {
      assert.notInclude(JSON.stringify(item), "fake-dev-token");
      assert.include(JSON.stringify(item), "/pair#token=REDACTED");
    }
  }).pipe(Effect.provide(layerTest)),
);
