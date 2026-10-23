import { describe, expect, it } from "vite-plus/test";

import { edgePoint, lane, LANE_GAP } from "./ribbon.ts";

describe("edgePoint", () => {
  it("leaves the box on the side that faces the other point", () => {
    const box = { x: 0, y: 0, w: 100, h: 40 };
    expect(edgePoint(box, { x: 300, y: 0 }).x).toBeGreaterThan(50);
    expect(edgePoint(box, { x: 300, y: 0 }).y).toBe(0);
    expect(edgePoint(box, { x: 0, y: -300 }).y).toBeLessThan(-20);
  });
});

describe("lane", () => {
  it("puts the two directions of a pair on opposite sides of the center line", () => {
    const a = { x: 0, y: 0, w: 100, h: 40 };
    const b = { x: 400, y: 0, w: 100, h: 40 };
    const there = lane(a, b);
    const back = lane(b, a);
    expect(there.chip.y).toBeCloseTo(LANE_GAP);
    expect(back.chip.y).toBeCloseTo(-LANE_GAP);
    expect(there.chip.x).toBeGreaterThan(200);
    expect(back.chip.x).toBeLessThan(200);
  });
});
