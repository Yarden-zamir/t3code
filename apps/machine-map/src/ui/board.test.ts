import { describe, expect, it } from "vite-plus/test";
import type { MachineLevel, MapProposal } from "@t3tools/contracts/machineMap";

import type { PauseView } from "../api.ts";
import { arrowChange, clientArrowChange } from "../rules/access.ts";
import { applyChanges, findArrow } from "../rules/map.ts";
import { client, MAC, PHONE, threeMachines, VPS, WIN } from "../rules/testMap.ts";
import { boardLanes, columnAt, laneMove, laneShift, returnsTo, type BoardLane } from "./board.ts";

const base = threeMachines();
const map = applyChanges({ ...base, clients: [client()] }, [
  arrowChange(base, { from: MAC, to: VPS, level: "admin", expiresAt: null }),
  arrowChange(base, {
    from: MAC,
    to: WIN,
    level: "standard",
    expiresAt: "2026-10-20T10:00:00.000Z",
  }),
  clientArrowChange(
    { ...base, clients: [client()] },
    { client: PHONE, to: VPS, level: "read", expiresAt: null },
  ),
]).map;

const proposal = (from: typeof MAC, to: typeof MAC, level: MachineLevel): MapProposal => ({
  id: `p-${from}-${to}`,
  at: "2026-10-20T08:00:00.000Z",
  expiresAt: "2026-10-21T08:00:00.000Z",
  actor: { _tag: "agent", machineId: from, threadId: null, threadTitle: null },
  summary: "asks",
  changes: [{ _tag: "setArrow", arrow: { ...findArrow(map, from, to), level } }],
  reason: "self-escalation",
});

const lane = (lanes: ReadonlyArray<BoardLane>, key: string): BoardLane => {
  const found = lanes.find((l) => l.key === key);
  if (!found) throw new Error(`No lane ${key}.`);
  return found;
};
const columnOf = (l: BoardLane, to: string) => l.chips.find((c) => c.grant.to.id === to)?.column;

describe("boardLanes (MM-1123)", () => {
  it("gives each machine and client one lane, with a chip per machine it can use", () => {
    const lanes = boardLanes(map, [], null);
    expect(lanes.map((l) => l.key)).toEqual([
      `machine:${MAC}`,
      `machine:${VPS}`,
      `machine:${WIN}`,
      `client:${PHONE}`,
    ]);
    const mac = lane(lanes, `machine:${MAC}`);
    expect(mac.chips.map((c) => c.grant.to.id)).toEqual([VPS, WIN]);
    expect(lane(lanes, `client:${PHONE}`).chips.map((c) => c.grant.to.id)).toEqual([MAC, VPS, WIN]);
  });

  it("puts each chip in the column of its level", () => {
    const lanes = boardLanes(map, [], null);
    const mac = lane(lanes, `machine:${MAC}`);
    expect(columnOf(mac, VPS)).toBe("admin");
    expect(columnOf(mac, WIN)).toBe("standard");
    expect(columnOf(lane(lanes, `machine:${VPS}`), MAC)).toBe("none");
    expect(columnOf(lane(lanes, `client:${PHONE}`), VPS)).toBe("read");
  });

  it("keeps a cut chip in its column from before the pause, machine and client alike (MM-717)", () => {
    const paused = applyChanges(map, [
      arrowChange(map, { from: MAC, to: VPS, level: "none", expiresAt: null }),
      clientArrowChange(map, { client: PHONE, to: VPS, level: "none", expiresAt: null }),
    ]).map;
    const pause: PauseView = {
      pausedAt: "2026-10-20T08:00:00.000Z",
      by: { _tag: "portal", reason: "test" },
      revision: null,
      cut: [{ from: MAC, to: VPS, level: "admin" }],
      cutClients: [{ client: PHONE, to: VPS, level: "read" }],
    };
    const lanes = boardLanes(paused, [], pause);
    const chip = lane(lanes, `machine:${MAC}`).chips.find((c) => c.grant.to.id === VPS);
    expect(chip?.column).toBe("admin");
    expect(chip?.cut).toBe("admin");
    expect(columnOf(lane(lanes, `client:${PHONE}`), VPS)).toBe("read");
  });

  it("shows a proposal only in the lane of its source, in the column it asks for", () => {
    const lanes = boardLanes(map, [proposal(VPS, MAC, "standard")], null);
    expect(lane(lanes, `machine:${VPS}`).asks.map((a) => a.arrow.level)).toEqual(["standard"]);
    expect(lane(lanes, `machine:${MAC}`).asks).toEqual([]);
  });

  it("marks the column a temporary chip returns to (MM-304)", () => {
    const mac = lane(boardLanes(map, [], null), `machine:${MAC}`);
    expect(returnsTo(mac, "none").map((c) => c.grant.to.id)).toEqual([WIN]);
    expect(returnsTo(mac, "standard")).toEqual([]);
  });
});

describe("lane moves (MM-1123)", () => {
  // Four columns of 100 pixels from x = 200: None, Read only, Standard, Admin.
  const edges = [0, 1, 2, 3].map((i) => ({ left: 200 + i * 100, right: 300 + i * 100 }));

  it("maps the pointer to the column of the lane in level order", () => {
    expect([250, 350, 450, 550].map((x) => columnAt(edges, x))).toEqual([
      "none",
      "read",
      "standard",
      "admin",
    ]);
  });

  it("never leaves the lane: a pointer past either end takes the end column", () => {
    expect(columnAt(edges, -5000)).toBe("none");
    expect(columnAt(edges, 5000)).toBe("admin");
    // A chip centered at x = 450 moves at most to the lane edges.
    expect(laneShift(edges, 450, -900)).toBe(-250);
    expect(laneShift(edges, 450, 900)).toBe(150);
    expect(laneShift(edges, 450, 30)).toBe(30);
  });

  it("refuses a lane without one column per level", () => {
    expect(() => columnAt(edges.slice(1), 250)).toThrow();
  });

  const chips = lane(boardLanes(map, [], null), `machine:${MAC}`).chips;
  const admin = chips.find((c) => c.grant.to.id === VPS);
  if (!admin) throw new Error("No admin chip.");

  it("sets a permanent level, removes at None, and stays in its own column", () => {
    expect(laneMove(admin, "read", false)).toEqual({ _tag: "set", level: "read" });
    expect(laneMove(admin, "none", false)).toEqual({ _tag: "remove" });
    expect(laneMove(admin, "admin", false)).toEqual({ _tag: "stay" });
  });

  it("only lowers while paused, and leaves a cut chip to Resume (MM-711, MM-717)", () => {
    const standard = chips.find((c) => c.grant.to.id === WIN);
    if (!standard) throw new Error("No standard chip.");
    expect(laneMove(standard, "admin", true)).toEqual({ _tag: "paused" });
    expect(laneMove(standard, "read", true)).toEqual({ _tag: "set", level: "read" });
    expect(laneMove({ ...admin, cut: "admin" }, "read", true)).toEqual({ _tag: "stay" });
  });
});
