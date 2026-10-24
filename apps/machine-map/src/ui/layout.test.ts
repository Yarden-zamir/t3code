import { describe, expect, it } from "vite-plus/test";

import {
  anyInView,
  autoLayout,
  fitView,
  MAX_ZOOM,
  separate,
  toMapPoint,
  toScreenPoint,
  wireGeometry,
  zoomAt,
  type Box,
  type LayoutCard,
  type Point,
} from "./layout.ts";

const overlaps = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

const anyOverlap = (boxes: ReadonlyArray<Box>) =>
  boxes.some((a, i) => boxes.some((b, j) => i < j && overlaps(a, b)));

const card = (x: number, y: number): Box => ({ x, y, w: 224, h: 110 });

describe("separate (MM-1103)", () => {
  it("leaves cards that do not overlap where they are", () => {
    const boxes = [card(200, 200), card(700, 200), card(450, 600)];
    expect(separate(boxes)).toEqual(boxes);
  });

  it("pulls apart cards on the same spot", () => {
    const out = separate([card(300, 300), card(300, 300), card(310, 305)]);
    expect(anyOverlap(out)).toBe(false);
  });

  it("moves only the cards that are not fixed", () => {
    const fixed = card(400, 300);
    const out = separate([fixed, card(420, 310)], new Set([0]));
    expect(out[0]).toEqual(fixed);
    expect(overlaps(out[0] ?? fixed, out[1] ?? fixed)).toBe(false);
  });
});

describe("zoom and pan (MM-1116)", () => {
  it.each([390, 768, 1280])("fits every card above the controls at %s pixels wide", (width) => {
    const boxes = [
      { x: 100, y: 100, w: 224, h: 280 },
      { x: 700, y: 100, w: 224, h: 279 },
      { x: 1100, y: 470, w: 190, h: 158 },
    ];
    const view = fitView(boxes, width, 600)!;
    for (const box of boxes) {
      const topLeft = toScreenPoint(view, { x: box.x - box.w / 2, y: box.y - box.h / 2 });
      const bottomRight = toScreenPoint(view, { x: box.x + box.w / 2, y: box.y + box.h / 2 });
      expect(topLeft.x).toBeGreaterThanOrEqual(0);
      expect(topLeft.y).toBeGreaterThanOrEqual(0);
      expect(bottomRight.x).toBeLessThanOrEqual(width);
      expect(bottomRight.y).toBeLessThan(600 - 64);
    }
  });

  it("keeps the point under the pointer, stops at the limits, and fits every card", () => {
    const view = zoomAt({ x: 40, y: 10, k: 1 }, { x: 300, y: 200 }, 1.5);
    expect(toScreenPoint(view, toMapPoint({ x: 40, y: 10, k: 1 }, { x: 300, y: 200 }))).toEqual({
      x: 300,
      y: 200,
    });
    expect(zoomAt(view, { x: 0, y: 0 }, 100).k).toBe(MAX_ZOOM);
    const fitted = fitView([card(100, 100), card(2000, 900)], 800, 600);
    expect(fitted && anyInView(fitted, [card(2000, 900)], 800, 600)).toBe(true);
    expect(fitView([], 800, 600)).toBeNull();
  });
});

describe("autoLayout (MM-1121)", () => {
  // Five machines on top of each other, and a client: a hub with three spokes, one free machine.
  const cards: Array<LayoutCard> = ["hub", "a", "b", "c", "free", "client"].map((id) => ({
    id,
    ...card(500, 300),
  }));
  const links = ["a", "b", "c", "client"].map((id) => ({ a: "hub", b: id, length: 400 }));
  const notes = [{ x: 500, y: 300, w: 190, h: 80 }];
  const center = { x: 700, y: 350 };
  const sized = (points: ReadonlyArray<Point>): Array<Box> =>
    points.map((p, i) => ({ ...p, w: cards[i]?.w ?? 0, h: cards[i]?.h ?? 0 }));
  const distance = (points: ReadonlyArray<Point>, i: number, j: number) => {
    const a = points[i];
    const b = points[j];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Number.NaN;
  };

  it("leaves no card on another card or a note", () => {
    const out = autoLayout(cards, links, notes, center, 2);
    expect(
      anyOverlap([...sized(out.cards), ...out.notes.map((p) => ({ ...p, w: 190, h: 80 }))]),
    ).toBe(false);
  });

  it("keeps linked cards closer than cards with no link", () => {
    const out = autoLayout(cards, links, notes, center, 2);
    const linked = Math.max(...[1, 2, 3, 5].map((i) => distance(out.cards, 0, i)));
    expect(linked).toBeLessThan(distance(out.cards, 0, 4));
  });

  it("keeps a map that it laid out before", () => {
    const first = autoLayout(cards, links, notes, center, 2);
    const again = autoLayout(
      sized(first.cards).map((box, i) => ({ ...box, id: cards[i]?.id ?? "" })),
      links,
      notes,
      center,
      2,
    );
    for (const [i, p] of again.cards.entries())
      expect(distance([p, ...first.cards], 0, i + 1)).toBeLessThan(1);
  });
});

describe("wireGeometry (MM-1103)", () => {
  const a = card(100, 100);
  const b = card(700, 100);
  /** The path is "M<start>Q<control> <end>". */
  const ends = (d: string) => {
    const [start = "", curve = ""] = d.slice(1).split("Q");
    const point = (text = "") => text.split(",").map(Number);
    return { start: point(start), end: point(curve.split(" ")[1]) };
  };

  it("runs from the edge of the source card to just before the target card", () => {
    const { start, end } = ends(wireGeometry(a, b, false).d);
    expect(start).toEqual([a.x + a.w / 2, 100]);
    expect(end[0]).toBeLessThan(b.x - b.w / 2);
    expect(end[1]).toBeCloseTo(100);
  });

  it("bows the two arrows of a two-way pair apart, with their badges apart", () => {
    const there = wireGeometry(a, b, true);
    const back = wireGeometry(b, a, true);
    expect(there.d).not.toBe(back.d);
    expect(Math.hypot(there.badge.x - back.badge.x, there.badge.y - back.badge.y)).toBeGreaterThan(
      40,
    );
  });
});
