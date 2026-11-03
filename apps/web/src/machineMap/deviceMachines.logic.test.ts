import { EnvironmentId, MachineId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deviceSyncStep,
  LIST_EVENT_GAP_MS,
  LIST_INTERVAL_MS,
  listedOrigins,
  PAIR_RETRY_MAX_MS,
  pairsDue,
  planDeviceMachines,
  type SavedEnvironment,
} from "./deviceMachines.logic";

const VPS = "https://t3-vps.example.com";
const MAC = "https://t3-mac.example.com";

const saved = (
  origin: string,
  phase: SavedEnvironment["phase"] = "connected",
): SavedEnvironment => ({
  environmentId: EnvironmentId.make(origin),
  origin,
  phase,
});

describe("planDeviceMachines", () => {
  it("pairs a new or refused managed machine and leaves a hand-saved one alone", () => {
    expect(
      planDeviceMachines({
        listed: [VPS, MAC],
        managed: new Set([VPS]),
        saved: [saved(VPS, "error"), saved(MAC)],
      }),
    ).toEqual({ keep: [VPS], pair: [VPS], remove: [] });
  });

  it("removes a managed machine that the list dropped, but nothing for an empty list", () => {
    const managed = new Set([VPS, MAC]);
    expect(
      planDeviceMachines({ listed: [VPS], managed, saved: [saved(VPS), saved(MAC)] }).remove,
    ).toEqual([{ origin: MAC, environmentId: EnvironmentId.make(MAC) }]);
    expect(planDeviceMachines({ listed: [], managed, saved: [saved(VPS)] }).remove).toEqual([]);
  });
});

describe("listedOrigins", () => {
  it("never adds this machine's own card a second time", () => {
    const machines = [
      { id: MachineId.make("mac"), name: "Mac", origin: `${MAC}/` },
      { id: MachineId.make("vps"), name: "VPS", origin: VPS },
    ];
    const originOf = (url: string) => URL.parse(url)?.origin ?? null;
    expect(listedOrigins(machines, "mac", originOf)).toEqual([VPS]);
    expect(listedOrigins(machines, null, originOf)).toEqual([MAC, VPS]);
  });
});

describe("deviceSyncStep", () => {
  const visible = { hidden: false, running: false, lastSyncAtMs: 0 } as const;

  it("syncs nothing while hidden, and syncs on the next event after a due interval", () => {
    const nowMs = LIST_INTERVAL_MS * 3;
    expect(deviceSyncStep({ ...visible, hidden: true, trigger: "tick", nowMs })).toBe("none");
    expect(deviceSyncStep({ ...visible, hidden: true, trigger: "event", nowMs })).toBe("none");
    expect(deviceSyncStep({ ...visible, trigger: "event", nowMs })).toBe("sync");
    expect(deviceSyncStep({ ...visible, trigger: "event", lastSyncAtMs: null, nowMs: 0 })).toBe(
      "sync",
    );
  });

  it("syncs at most once per interval from the timer", () => {
    const due = { ...visible, trigger: "tick" } as const;
    expect(deviceSyncStep({ ...due, nowMs: LIST_INTERVAL_MS - 1 })).toBe("none");
    expect(deviceSyncStep({ ...due, nowMs: LIST_INTERVAL_MS })).toBe("sync");
  });

  it("does not sync twice for a focus right after a visibility change", () => {
    const event = { ...visible, trigger: "event" } as const;
    expect(deviceSyncStep({ ...event, running: true, lastSyncAtMs: null, nowMs: 0 })).toBe("none");
    expect(deviceSyncStep({ ...event, nowMs: LIST_EVENT_GAP_MS - 1 })).toBe("none");
    expect(deviceSyncStep({ ...event, nowMs: LIST_EVENT_GAP_MS })).toBe("sync");
  });

  it("pairs a machine that was never tried, for example after a join, at once", () => {
    expect(pairsDue({ waiting: [VPS], offline: new Set(), failures: new Map(), nowMs: 0 })).toEqual(
      [VPS],
    );
  });

  it("never pairs a machine that the list shows offline", () => {
    expect(
      pairsDue({ waiting: [VPS, MAC], offline: new Set([MAC]), failures: new Map(), nowMs: 0 }),
    ).toEqual([VPS]);
  });

  it("retries a failed machine only after its backoff, never sooner than the list interval", () => {
    const failed = (count: number) => new Map([[VPS, { count, atMs: 0 }]]);
    const due = (count: number, nowMs: number) =>
      pairsDue({ waiting: [VPS], offline: new Set(), failures: failed(count), nowMs });
    expect(due(1, LIST_EVENT_GAP_MS)).toEqual([]);
    expect(due(1, LIST_INTERVAL_MS - 1)).toEqual([]);
    expect(due(1, LIST_INTERVAL_MS)).toEqual([VPS]);
    expect(due(2, LIST_INTERVAL_MS)).toEqual([]);
    expect(due(9, PAIR_RETRY_MAX_MS - 1)).toEqual([]);
    expect(due(9, PAIR_RETRY_MAX_MS)).toEqual([VPS]);
  });
});
