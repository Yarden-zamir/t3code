import { assert, it } from "@effect/vitest";
import { EventId, ThreadId, TurnItemId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
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

const threadId = ThreadId.make("thread:preview-token");

const toolCall = (
  name: string,
  toolName: string,
  url: string,
  now: DateTime.Utc,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${name}`),
  type: "turn-item.updated",
  threadId,
  occurredAt: now,
  payload: {
    id: TurnItemId.make(`item:${name}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: `Open ${url}`,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "dynamic_tool",
    toolName,
    input: { url },
    output: [{ type: "text", text: JSON.stringify({ url }) }],
  },
});

it.effect("stores a preview tool call with its URL token hidden, and other tools unchanged", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    // A fake token: the real one never enters a test.
    const pairingUrl = "http://127.0.0.1:5733/pair#token=fake-dev-token";
    const docsUrl = "https://docs.example.test/oauth?code=x";

    const [preview, other] = yield* sink.write({
      events: [
        toolCall("preview-open", "mcp__t3-code__preview_open", pairingUrl, now),
        toolCall("web-fetch", "WebFetch", docsUrl, now),
      ],
    });

    const persistedPreview = yield* projections.getTurnItem({
      threadId,
      itemId: TurnItemId.make("item:preview-open"),
    });
    for (const item of [preview?.event.payload, persistedPreview]) {
      assert.notInclude(JSON.stringify(item), "fake-dev-token");
      assert.include(JSON.stringify(item), "/pair#token=REDACTED");
    }
    const persistedOther = yield* projections.getTurnItem({
      threadId,
      itemId: TurnItemId.make("item:web-fetch"),
    });
    for (const item of [other?.event.payload, persistedOther]) {
      assert.include(JSON.stringify(item), "?code=x");
      assert.notInclude(JSON.stringify(item), "REDACTED");
    }
  }).pipe(Effect.provide(layerTest)),
);
