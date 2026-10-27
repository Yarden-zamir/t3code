/// <reference types="node" />
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { MachineId } from "@t3tools/contracts/machineMap";
import type { HealthAlert, ResourceSample } from "@t3tools/contracts/machineMapResources";

import { HEALTH_TABLES, HealthStore } from "./healthStore.ts";
import {
  BLOCK_MS,
  HOUR_MS,
  MAX_ENDED_ALERTS,
  MINUTE_MS,
  MINUTE_RETENTION_MS,
  pointOf,
} from "./rules/health.ts";

const MAC = MachineId.make("mac");
const VPS = MachineId.make("vps");
const T0 = Date.parse("2026-10-13T08:00:00.000Z");

/** The store on an in-memory `node:sqlite` database, like `ctx.storage.sql` in the Worker. */
function memoryStore() {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  db.exec(HEALTH_TABLES);
  const store = new HealthStore({
    run: <T>(query: string, ...bindings: Array<string | number | null>) =>
      db.prepare(query).all(...bindings) as Array<T>,
    transaction: (work) => {
      db.exec("BEGIN");
      try {
        work();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  });
  return { db, store };
}

const sample = (cpuPercent: number): ResourceSample => ({
  at: "2026-10-13T08:00:00.000Z",
  cpuPercent,
  cpuBusyPercent: null,
  cpuStealPercent: null,
  cpuPressurePercent: null,
  cpuCount: 4,
  load: null,
  memoryUsedBytes: 1,
  memoryTotalBytes: 2,
  swapUsedBytes: null,
  swapTotalBytes: null,
  swapBytesPerSecond: null,
  diskUsedBytes: null,
  diskTotalBytes: null,
  netInBytesPerSecond: null,
  netOutBytesPerSecond: null,
  t3: null,
  agents: null,
  topCpu: null,
  topMemory: null,
  battery: null,
});

const at = (atMs: number, cpu: number) => ({ atMs, point: pointOf(sample(cpu)) });

const alert = (id: string, startedAt: number, endedAt: number | null): HealthAlert => ({
  id,
  machineId: MAC,
  kind: "cpu",
  startedAt: new Date(startedAt).toISOString(),
  endedAt: endedAt === null ? null : new Date(endedAt).toISOString(),
  value: 95,
  threshold: 90,
});

describe("HealthStore (MM-1503, MM-1505)", () => {
  it("merges minute points into 10-minute blocks and sets the hour point to the mean", () => {
    const { db, store } = memoryStore();
    store.store(MAC, [at(T0, 10)], sample(10));
    // A point at a stored minute replaces it.
    store.store(MAC, [at(T0, 20), at(T0 + MINUTE_MS, 60)], sample(60));
    const minutes = () => store.points(MAC, "minute", 0).map((p) => [p.atMs, p.point.cpu]);
    expect(minutes()).toEqual([
      [T0, 20],
      [T0 + MINUTE_MS, 60],
    ]);
    expect(store.points(MAC, "hour", 0)).toEqual([
      { atMs: T0, point: expect.objectContaining({ cpu: 40, cpuMax: 60, memory: 50 }) },
    ]);
    expect(store.latest(new Set([MAC, VPS]))).toEqual({ [MAC]: sample(60) });
    // The next block is a second row. Storing the same points again changes nothing.
    store.store(MAC, [at(T0 + BLOCK_MS, 30)], sample(30));
    store.store(MAC, [at(T0 + BLOCK_MS, 30)], sample(30));
    expect(minutes()).toEqual([
      [T0, 20],
      [T0 + MINUTE_MS, 60],
      [T0 + BLOCK_MS, 30],
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM resource_points WHERE step = 'b'").get()).toEqual({
      n: 2,
    });
    expect(store.points(MAC, "minute", T0 + MINUTE_MS).map((p) => p.atMs)).toEqual([
      T0 + MINUTE_MS,
      T0 + BLOCK_MS,
    ]);
  });

  it("prunes blocks after 24 hours", () => {
    const { store } = memoryStore();
    const now = T0 + 48 * HOUR_MS;
    // A block whose newest minute is older than 24 hours: gone.
    store.store(MAC, [at(now - MINUTE_RETENTION_MS - BLOCK_MS - MINUTE_MS, 1)], sample(1));
    store.store(MAC, [at(now, 5)], sample(5));
    store.prune(now, [MAC]);
    expect(store.points(MAC, "minute", 0).map((p) => p.atMs)).toEqual([now]);
    // Hour points stay 30 days.
    expect(store.points(MAC, "hour", 0)).toHaveLength(2);
  });

  it("keeps active alerts, drops ended ones past 30 days or over the cap", () => {
    const { store } = memoryStore();
    const now = T0 + 40 * 24 * HOUR_MS;
    store.saveAlert(alert("old-active", T0, null));
    store.saveAlert(alert("old-ended", T0, T0 + MINUTE_MS));
    for (let i = 0; i < MAX_ENDED_ALERTS + 5; i += 1) {
      store.saveAlert(alert(`ended-${i}`, now - (i + 1) * MINUTE_MS, now - i * MINUTE_MS));
    }
    store.prune(now, [MAC]);
    const alerts = store.alerts(10_000);
    expect(alerts[0]?.id).toBe("old-active");
    expect(alerts.some((a) => a.id === "old-ended")).toBe(false);
    expect(alerts.filter((a) => a.endedAt !== null)).toHaveLength(MAX_ENDED_ALERTS);
    expect(store.alerts(0).map((a) => a.id)).toEqual(["old-active"]);
  });

  it("forgets a removed machine", () => {
    const { store } = memoryStore();
    store.store(MAC, [at(T0, 5)], sample(5));
    store.saveAlert(alert("a", T0, null));
    store.removeMachine(MAC);
    expect(store.hasPoints()).toBe(false);
    expect(store.latest(new Set([MAC]))).toEqual({});
    expect(store.alerts(10)).toEqual([]);
  });
});
