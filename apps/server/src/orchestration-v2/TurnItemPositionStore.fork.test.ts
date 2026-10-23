import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerTest = TurnItemPositionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("places a held queued run that resumes after a restart continuation below it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:held-queue");
    const allocate = (runOrdinal: number, item: string) =>
      positions.allocate({
        threadId,
        turnItemId: TurnItemId.make(item),
        runId: RunId.make(`run:${runOrdinal}`),
        runOrdinal,
      });

    const cut = yield* allocate(18, "item:cut");
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
      )
      VALUES ('item:cut', ${threadId}, 'run:18', ${cut}, 'assistant_message', 'completed', '', '{}')
    `;
    const continuation = yield* allocate(21, "item:continuation");
    // The resumed run's items are normalized before the projection stores any of them.
    const resumedUser = yield* allocate(19, "item:resumed-user");
    const resumedAnswer = yield* allocate(19, "item:resumed-answer");
    const lateCut = yield* allocate(18, "item:cut-late");

    assert.isTrue(continuation < resumedUser && resumedUser < resumedAnswer);
    assert.isTrue(cut < lateCut && lateCut < continuation);
  }).pipe(Effect.provide(layerTest)),
);
