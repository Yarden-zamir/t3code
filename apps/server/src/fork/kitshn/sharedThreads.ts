/**
 * Fork: the threads with an open guest share, for the `t3.thread` cards of the kitshn provider
 * (K-704: register only threads that a user shares).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export const SharedThread = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  shareId: Schema.String,
  host: Schema.String,
  expiresAt: Schema.String,
});
export type SharedThread = typeof SharedThread.Type;

/** Every live thread whose guest share is open, or none when the read fails. The caller drops the expired ones. */
export const makeListSharedThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SharedThread,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        COALESCE(json_extract(payload_json, '$.title'), '') AS "title",
        json_extract(payload_json, '$.guestShare.id') AS "shareId",
        json_extract(payload_json, '$.guestShare.host') AS "host",
        json_extract(payload_json, '$.guestShare.expiresAt') AS "expiresAt"
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND json_extract(payload_json, '$.archivedAt') IS NULL
        AND json_extract(payload_json, '$.guestShare.id') IS NOT NULL
    `,
  });
  // A failed read keeps the last cards instead of removing them.
  return query(undefined).pipe(Effect.option);
});
