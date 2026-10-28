/**
 * MM-1503, MM-1505: the SQLite tables of resources and health in the Durable Object: blocks of
 * minute points, hour points, the latest sample of each machine, and alerts. The rules live in `rules/health.ts`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { MachineId } from "@t3tools/contracts/machineMap";
import { HealthAlert, ResourceSample } from "@t3tools/contracts/machineMapResources";

import {
  averagePoints,
  BLOCK_MS,
  blockStart,
  HOUR_MS,
  HOUR_RETENTION_MS,
  hourStart,
  MAX_ENDED_ALERTS,
  MAX_HOUR_POINTS,
  MAX_MINUTE_POINTS,
  mergePoints,
  MINUTE_MS,
  MINUTE_RETENTION_MS,
  type TimedPoint,
} from "./rules/health.ts";

type SqlValue = string | number | null;

/**
 * The SQL that the store needs. The Durable Object passes `ctx.storage.sql`; the tests pass an
 * in-memory `node:sqlite` database.
 */
export interface SqlRunner {
  run<T extends Record<string, SqlValue>>(query: string, ...bindings: Array<SqlValue>): Array<T>;
  transaction(work: () => void): void;
}

/** A point that an older portal stored has no value of a newer field. */
const NewerValue = Schema.NullOr(Schema.Number).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
);

const ResourcePoint = Schema.Struct({
  cpu: Schema.NullOr(Schema.Number),
  cpuMax: Schema.NullOr(Schema.Number),
  busy: NewerValue,
  pressure: NewerValue,
  steal: NewerValue,
  battery: NewerValue,
  discharging: Schema.NullOr(Schema.Boolean).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  memory: Schema.NullOr(Schema.Number),
  disk: Schema.NullOr(Schema.Number),
  swap: Schema.NullOr(Schema.Number),
  agents: Schema.NullOr(Schema.Number),
  agentCpu: Schema.NullOr(Schema.Number),
});

/** A minute point with its time, as a block row and the machine socket hold it. */
export const TimedResourcePoint = Schema.Struct({ atMs: Schema.Number, point: ResourcePoint });

const decodeJson = <T>(schema: Schema.ConstraintDecoder<T>) => {
  const decode = Schema.decodeUnknownSync(schema);
  return (text: string): T => decode(JSON.parse(text));
};
const decodePoint = decodeJson(ResourcePoint);
const decodeBlock = decodeJson(Schema.Array(TimedResourcePoint));
const decodeSample = decodeJson(ResourceSample);
const decodeAlert = decodeJson(HealthAlert);

/** `b` rows hold a block of minute points, `h` rows one hour point. */
const BLOCK_STEP = "b";
const HOUR_STEP = "h";
/** MM-1503: the size cap of the blocks of one machine. */
const MAX_BLOCKS = Math.ceil(MAX_MINUTE_POINTS / (BLOCK_MS / MINUTE_MS));

export const HEALTH_TABLES = `
  CREATE TABLE IF NOT EXISTS resource_points (machine_id TEXT NOT NULL, step TEXT NOT NULL, at_ms INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (machine_id, step, at_ms));
  CREATE TABLE IF NOT EXISTS resource_latest (machine_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS health_alerts (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, active INTEGER NOT NULL, started_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS health_alerts_by_start ON health_alerts (started_at);
  CREATE INDEX IF NOT EXISTS health_alerts_by_active_start ON health_alerts (active, started_at);
`;

export class HealthStore {
  readonly #sql: SqlRunner;

  constructor(sql: SqlRunner) {
    this.#sql = sql;
  }

  /**
   * MM-1503: adds minute points to their blocks, sets the hour point of each touched hour to the
   * average of its minute points, and keeps `latest` as the latest sample. A stored point at the
   * same minute is replaced, so storing the same points twice changes nothing.
   */
  store(machineId: MachineId, points: ReadonlyArray<TimedPoint>, latest: ResourceSample): void {
    const blocks = new Map<number, Array<TimedPoint>>();
    for (const p of points) {
      const start = blockStart(p.atMs);
      blocks.set(start, [...(blocks.get(start) ?? []), p]);
    }
    this.#sql.transaction(() => {
      for (const [start, fresh] of blocks) {
        const row = this.#sql.run<{ data: string }>(
          "SELECT data FROM resource_points WHERE machine_id = ? AND step = ? AND at_ms = ?",
          machineId,
          BLOCK_STEP,
          start,
        )[0];
        this.#put(
          machineId,
          BLOCK_STEP,
          start,
          mergePoints(row ? decodeBlock(row.data) : [], fresh),
        );
      }
      for (const hour of new Set(points.map((p) => hourStart(p.atMs)))) {
        const minutes = this.points(machineId, "minute", hour)
          .filter((p) => p.atMs < hour + HOUR_MS)
          .map((p) => p.point);
        this.#put(machineId, HOUR_STEP, hour, averagePoints(minutes));
      }
      this.#sql.run(
        "INSERT OR REPLACE INTO resource_latest (machine_id, data) VALUES (?, ?)",
        machineId,
        JSON.stringify(latest),
      );
    });
  }

  #put(machineId: MachineId, step: string, atMs: number, data: unknown): void {
    this.#sql.run(
      "INSERT OR REPLACE INTO resource_points (machine_id, step, at_ms, data) VALUES (?, ?, ?, ?)",
      machineId,
      step,
      atMs,
      JSON.stringify(data),
    );
  }

  /** Stored points of one machine from `fromMs` on, oldest first. */
  points(machineId: MachineId, step: "minute" | "hour", fromMs: number): Array<TimedPoint> {
    if (step === "hour") {
      return this.#sql
        .run<{ at_ms: number; data: string }>(
          "SELECT at_ms, data FROM resource_points WHERE machine_id = ? AND step = ? AND at_ms >= ? ORDER BY at_ms",
          machineId,
          HOUR_STEP,
          fromMs,
        )
        .map((row) => ({ atMs: row.at_ms, point: decodePoint(row.data) }));
    }
    return this.#sql
      .run<{ data: string }>(
        "SELECT data FROM resource_points WHERE machine_id = ? AND step = ? AND at_ms >= ? ORDER BY at_ms",
        machineId,
        BLOCK_STEP,
        blockStart(fromMs),
      )
      .flatMap((row) => decodeBlock(row.data).filter((p) => p.atMs >= fromMs));
  }

  hasPoints(): boolean {
    return this.#sql.run("SELECT 1 AS one FROM resource_points LIMIT 1").length > 0;
  }

  /** The latest sample of each machine in `machineIds`. */
  latest(machineIds: ReadonlySet<string>): Record<string, ResourceSample> {
    return Object.fromEntries(
      this.#sql
        .run<{ machine_id: string; data: string }>("SELECT machine_id, data FROM resource_latest")
        .filter((row) => machineIds.has(row.machine_id))
        .map((row) => [row.machine_id, decodeSample(row.data)]),
    );
  }

  /** The active alerts, newest first, then up to `ended` ended ones. */
  alerts(ended: number): Array<HealthAlert> {
    const active = this.#sql
      .run<{ data: string }>(
        "SELECT data FROM health_alerts WHERE active = 1 ORDER BY started_at DESC",
      )
      .map((row) => decodeAlert(row.data));
    if (ended === 0) return active;
    const done = this.#sql
      .run<{ data: string }>(
        "SELECT data FROM health_alerts WHERE active = 0 ORDER BY started_at DESC LIMIT ?",
        ended,
      )
      .map((row) => decodeAlert(row.data));
    return [...active, ...done];
  }

  /** The alerts of one machine that are active or started at `since` or later. */
  alertsOf(machineId: MachineId, since: string): Array<HealthAlert> {
    return this.#sql
      .run<{ data: string }>(
        "SELECT data FROM health_alerts WHERE machine_id = ? AND (active = 1 OR started_at >= ?) ORDER BY started_at DESC",
        machineId,
        since,
      )
      .map((row) => decodeAlert(row.data));
  }

  saveAlert(alert: HealthAlert): void {
    this.#sql.run(
      "INSERT OR REPLACE INTO health_alerts (id, machine_id, active, started_at, data) VALUES (?, ?, ?, ?, ?)",
      alert.id,
      alert.machineId,
      alert.endedAt === null ? 1 : 0,
      alert.startedAt,
      JSON.stringify(alert),
    );
  }

  /**
   * MM-1503, MM-1505: drops points past their retention or over the size cap of each machine,
   * and ended alerts past 30 days or over their cap. Active alerts stay.
   */
  prune(nowMs: number, machineIds: ReadonlyArray<string>): void {
    this.#sql.transaction(() => {
      // A block goes when its newest minute passes the retention.
      this.#sql.run(
        "DELETE FROM resource_points WHERE (step != ? AND at_ms < ?) OR (step = ? AND at_ms < ?)",
        HOUR_STEP,
        nowMs - MINUTE_RETENTION_MS - BLOCK_MS,
        HOUR_STEP,
        nowMs - HOUR_RETENTION_MS,
      );
      for (const machineId of machineIds) {
        for (const [step, cap] of [
          [BLOCK_STEP, MAX_BLOCKS],
          [HOUR_STEP, MAX_HOUR_POINTS],
        ] as const) {
          this.#sql.run(
            `DELETE FROM resource_points WHERE machine_id = ? AND step = ? AND at_ms NOT IN
               (SELECT at_ms FROM resource_points WHERE machine_id = ? AND step = ? ORDER BY at_ms DESC LIMIT ?)`,
            machineId,
            step,
            machineId,
            step,
            cap,
          );
        }
      }
      this.#sql.run(
        "DELETE FROM health_alerts WHERE active = 0 AND started_at < ?",
        new Date(nowMs - HOUR_RETENTION_MS).toISOString(),
      );
      this.#sql.run(
        `DELETE FROM health_alerts WHERE active = 0 AND id NOT IN
           (SELECT id FROM health_alerts WHERE active = 0 ORDER BY started_at DESC LIMIT ?)`,
        MAX_ENDED_ALERTS,
      );
    });
  }

  /** MM-208: a removed machine leaves no resource rows behind. */
  removeMachine(machineId: MachineId): void {
    this.#sql.transaction(() => {
      for (const table of ["resource_points", "resource_latest", "health_alerts"]) {
        this.#sql.run(`DELETE FROM ${table} WHERE machine_id = ?`, machineId);
      }
    });
  }
}
