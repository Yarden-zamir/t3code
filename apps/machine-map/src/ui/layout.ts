/**
 * Pixel layout of the map (MM-1103). Saved positions can overlap, for example on a narrow phone
 * map or for machines that joined close together. The page shows them apart and does not save
 * the result, so every page keeps the same saved map.
 */

/** A card by its center and size, in pixels. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The space between two cards. */
const GAP = 14;
/** Rounds of pushing. A few machines settle in fewer; more rounds only cost time. */
const ROUNDS = 60;

/**
 * Pushes overlapping boxes apart. Boxes in `fixed` do not move. Each push takes the axis that
 * needs the shorter move. The map has no edges (MM-1114), so every push fits.
 */
export function separate(
  boxes: ReadonlyArray<Box>,
  fixed: ReadonlySet<number> = new Set(),
): Array<Box> {
  const out = [...boxes];
  for (let round = 0; round < ROUNDS; round++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        if (!a || !b || (fixed.has(i) && fixed.has(j))) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overlapX = (a.w + b.w) / 2 + GAP - Math.abs(dx);
        const overlapY = (a.h + b.h) / 2 + GAP - Math.abs(dy);
        if (overlapX <= 0.5 || overlapY <= 0.5) continue;
        const shareA = fixed.has(i) ? 0 : fixed.has(j) ? 1 : 0.5;
        // Identical centers split by their order, so the result never depends on chance.
        const useX = overlapX <= overlapY;
        const sign = useX ? (dx === 0 ? 1 : Math.sign(dx)) : dy === 0 ? 1 : Math.sign(dy);
        const push = (box: Box, by: number): Box =>
          useX ? { ...box, x: box.x + by * overlapX } : { ...box, y: box.y + by * overlapY };
        out[i] = push(a, -sign * shareA);
        out[j] = push(b, sign * (1 - shareA));
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * MM-1116: the view of the map on one device. The map layer moves by `x` and `y` screen pixels
 * and scales by `k`: a map point `p` shows at `p * k + (x, y)`.
 */
export interface MapViewport {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

/** MM-1116: the zoom limits. The map has no edges, so "Fit" can need a far zoom out. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;
export const clampZoom = (k: number) => clamp(k, MIN_ZOOM, MAX_ZOOM);

export const toMapPoint = (view: MapViewport, screen: Point): Point => ({
  x: (screen.x - view.x) / view.k,
  y: (screen.y - view.y) / view.k,
});

export const toScreenPoint = (view: MapViewport, point: Point): Point => ({
  x: point.x * view.k + view.x,
  y: point.y * view.k + view.y,
});

/** Zooms by `factor`. The map point under the screen point `at` stays under it. */
export function zoomAt(view: MapViewport, at: Point, factor: number): MapViewport {
  const k = clampZoom(view.k * factor);
  const p = toMapPoint(view, at);
  return { k, x: at.x - p.x * k, y: at.y - p.y * k };
}

/** The margin around the cards after "Fit", in screen pixels. */
const FIT_MARGIN = 24;

/**
 * MM-1116 "Fit": every box shows inside a `width` x `height` screen, centered, at most at 100%.
 * The bottom 64 pixels stay clear of the 44-pixel map controls and their bottom inset.
 * Null without boxes.
 */
export function fitView(
  boxes: ReadonlyArray<Box>,
  width: number,
  height: number,
): MapViewport | null {
  if (boxes.length === 0 || width <= 0 || height <= 0) return null;
  const availableHeight = Math.max(1, height - 64);
  const left = Math.min(...boxes.map((b) => b.x - b.w / 2));
  const right = Math.max(...boxes.map((b) => b.x + b.w / 2));
  const top = Math.min(...boxes.map((b) => b.y - b.h / 2));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h / 2));
  const k = clampZoom(
    Math.min(
      1,
      (width - 2 * FIT_MARGIN) / Math.max(1, right - left),
      (availableHeight - 2 * FIT_MARGIN) / Math.max(1, bottom - top),
    ),
  );
  return {
    k,
    x: width / 2 - ((left + right) / 2) * k,
    y: availableHeight / 2 - ((top + bottom) / 2) * k,
  };
}

/** Whether at least one box shows, in part, on a `width` x `height` screen. */
export function anyInView(
  view: MapViewport,
  boxes: ReadonlyArray<Box>,
  width: number,
  height: number,
): boolean {
  return boxes.some((b) => {
    const a = toScreenPoint(view, { x: b.x - b.w / 2, y: b.y - b.h / 2 });
    const z = toScreenPoint(view, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
    return a.x < width && z.x > 0 && a.y < height && z.y > 0;
  });
}

/** MM-1121: a card that "Auto layout" places, by its center and size. */
export interface LayoutCard extends Box {
  readonly id: string;
}

/** MM-1121: an arrow between two cards and the length its line wants, center to center. */
export interface LayoutLink {
  readonly a: string;
  readonly b: string;
  readonly length: number;
}

/** Rounds of the force layout. Its moves shrink each round, so the end is calm. */
const LAYOUT_ROUNDS = 400;
/** The largest move of a card in the first round, in map pixels. */
const LAYOUT_FIRST_STEP = 80;
/** Room between two cards, on top of their sizes. Closer cards push apart. */
const LAYOUT_ROOM = 50;
/** How hard closer cards push apart, and how hard a line pulls toward its length. */
const LAYOUT_PUSH = 0.5;
const LAYOUT_PULL = 0.2;
/**
 * How hard every card falls toward the middle. `settle` splits it by the shape of the view, so
 * the layout comes out wide on a desktop and tall on a phone.
 */
const LAYOUT_GRAVITY = 0.04;
/** Starts that the layout tries besides the current places. Each start costs one more run. */
const LAYOUT_STARTS = 12;
/** A fresh start must make the lines this much shorter to replace a start with as few faults. */
const LAYOUT_BETTER = 0.9;
/** The space between the cards and the notes, and between two notes. */
const NOTE_MARGIN = 60;
const NOTE_GAP = 30;

/** A small fixed pseudo-random sequence (mulberry32), so the same map gives the same layout. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** True when the segments `a`–`b` and `c`–`d` cross. Touching ends do not count. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/** True when the segment `a`–`b` passes through `box` (Liang–Barsky clipping). */
function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let low = 0;
  let high = 1;
  const edges: Array<readonly [number, number]> = [
    [-dx, a.x - (box.x - box.w / 2)],
    [dx, box.x + box.w / 2 - a.x],
    [-dy, a.y - (box.y - box.h / 2)],
    [dy, box.y + box.h / 2 - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) low = Math.max(low, t);
    else high = Math.min(high, t);
    if (low > high) return false;
  }
  return true;
}

/** Moves the cards from `start` with the forces, then removes every overlap. */
function settle(
  cards: ReadonlyArray<LayoutCard>,
  links: ReadonlyArray<readonly [number, number, number]>,
  start: ReadonlyArray<Point>,
  shape: number,
): Array<Box> {
  const gravityX = LAYOUT_GRAVITY / shape;
  const gravityY = LAYOUT_GRAVITY * shape;
  const at = [...start];
  for (let round = 0; round < LAYOUT_ROUNDS; round++) {
    const step = LAYOUT_FIRST_STEP * (1 - round / LAYOUT_ROUNDS) + 1;
    const push = at.map(() => ({ x: 0, y: 0 }));
    const middle = {
      x: at.reduce((sum, p) => sum + p.x, 0) / Math.max(1, at.length),
      y: at.reduce((sum, p) => sum + p.y, 0) / Math.max(1, at.length),
    };
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i];
        const b = cards[j];
        const pa = at[i];
        const pb = at[j];
        const fa = push[i];
        const fb = push[j];
        if (!a || !b || !pa || !pb || !fa || !fb) continue;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const room = Math.max(a.w + b.w, a.h + b.h) / 2 + LAYOUT_ROOM;
        if (distance >= room) continue;
        const force = (room - distance) * LAYOUT_PUSH;
        fa.x -= (dx / distance) * force;
        fa.y -= (dy / distance) * force;
        fb.x += (dx / distance) * force;
        fb.y += (dy / distance) * force;
      }
    }
    for (const [i, j, length] of links) {
      const pa = at[i];
      const pb = at[j];
      const fa = push[i];
      const fb = push[j];
      if (!pa || !pb || !fa || !fb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - length) * LAYOUT_PULL;
      fa.x += (dx / distance) * force;
      fa.y += (dy / distance) * force;
      fb.x -= (dx / distance) * force;
      fb.y -= (dy / distance) * force;
    }
    for (const [i, p] of at.entries()) {
      const f = push[i];
      if (!f) continue;
      const fx = f.x + (middle.x - p.x) * gravityX;
      const fy = f.y + (middle.y - p.y) * gravityY;
      const size = Math.hypot(fx, fy);
      const scale = size > step ? step / size : 1;
      at[i] = { x: p.x + fx * scale, y: p.y + fy * scale };
    }
  }
  return separate(cards.map((card, i) => ({ ...card, ...(at[i] ?? card) })));
}

/** Line crossings plus lines through a card that is not an end of the line, and the length of the lines. */
function judge(
  boxes: ReadonlyArray<Box>,
  links: ReadonlyArray<readonly [number, number, number]>,
): { readonly faults: number; readonly length: number } {
  let faults = 0;
  let length = 0;
  for (const [n, [i, j]] of links.entries()) {
    const a = boxes[i];
    const b = boxes[j];
    if (!a || !b) continue;
    length += Math.hypot(b.x - a.x, b.y - a.y);
    for (const [k, box] of boxes.entries()) {
      if (k !== i && k !== j && segmentHitsBox(a, b, box)) faults++;
    }
    for (const [k, l] of links.slice(n + 1)) {
      const c = boxes[k];
      const d = boxes[l];
      if (!c || !d || k === i || k === j || l === i || l === j) continue;
      if (segmentsCross(a, b, c, d)) faults++;
    }
  }
  return { faults, length };
}

/**
 * MM-1121 "Auto layout": a small force layout. Each line pulls its two cards toward its length,
 * two cards closer than their room push apart, and a pull toward the middle keeps the map
 * compact. `separate` then removes every overlap. The layout runs from the current places and from a few
 * fixed pseudo-random starts. It keeps the result with the fewest line crossings and lines through
 * cards, then the shortest lines. The current places win a tie, so a map that reads well keeps its
 * shape. Notes link to nothing, so they go beside the cards, where they cover no line. The result
 * is centered on `center` and has about the `shape` (width by height) of the view.
 *
 * Limit: the starts are a sample, not a search, so a dense map can keep a crossing that a
 * layered layout would remove. Revisit when maps grow past about 20 machines or the owner sees
 * crossings after "Auto layout": then use a layered layout library such as elkjs.
 */
export function autoLayout(
  cards: ReadonlyArray<LayoutCard>,
  links: ReadonlyArray<LayoutLink>,
  notes: ReadonlyArray<Box>,
  center: Point,
  shape: number,
): { readonly cards: Array<Point>; readonly notes: Array<Point> } {
  // A view with no size yet counts as square.
  const ratio = Number.isFinite(shape) && shape > 0 ? shape : 1;
  const index = new Map(cards.map((card, i) => [card.id, i]));
  const pairs = links.flatMap((link): Array<readonly [number, number, number]> => {
    const i = index.get(link.a);
    const j = index.get(link.b);
    return i === undefined || j === undefined || i === j ? [] : [[i, j, link.length]];
  });
  const random = sequence(1);
  const spreadX = 300 * Math.sqrt(cards.length * ratio);
  const spreadY = 300 * Math.sqrt(cards.length / ratio);
  const starts: Array<Array<Point>> = [
    // Cards on the same spot start a little apart, by their order.
    cards.map((card, i) => ({ x: card.x + i * 0.5, y: card.y + i * 0.5 })),
    ...Array.from({ length: LAYOUT_STARTS }, () =>
      cards.map(() => ({ x: random() * spreadX, y: random() * spreadY })),
    ),
  ];
  // The current places come first and win every tie, so a second click changes nothing.
  const candidates = [
    separate(cards),
    ...starts.map((start) => settle(cards, pairs, start, ratio)),
  ];
  let best: {
    readonly boxes: Array<Box>;
    readonly faults: number;
    readonly length: number;
  } | null = null;
  for (const boxes of candidates) {
    const { faults, length } = judge(boxes, pairs);
    if (
      !best ||
      faults < best.faults ||
      (faults === best.faults && length < best.length * LAYOUT_BETTER)
    )
      best = { boxes, faults, length };
  }
  const placed = best?.boxes ?? [];
  // Notes go in a column right of the cards on a wide view, and in a row below them on a tall one.
  const wide = ratio >= 1;
  const edge = (pick: (b: Box) => number) =>
    placed.length === 0 ? 0 : Math.max(...placed.map(pick)) + NOTE_MARGIN;
  const first = (pick: (b: Box) => number) =>
    placed.length === 0 ? 0 : Math.min(...placed.map(pick));
  const line = wide ? edge((b) => b.x + b.w / 2) : edge((b) => b.y + b.h / 2);
  let next = wide ? first((b) => b.y - b.h / 2) : first((b) => b.x - b.w / 2);
  const noteBoxes = notes.map((note): Box => {
    const box = wide
      ? { ...note, x: line + note.w / 2, y: next + note.h / 2 }
      : { ...note, x: next + note.w / 2, y: line + note.h / 2 };
    next += (wide ? note.h : note.w) + NOTE_GAP;
    return box;
  });
  // Everything moves so the whole layout is centered on `center`.
  const all = [...placed, ...noteBoxes];
  if (all.length === 0) return { cards: [], notes: [] };
  const middleX =
    (Math.min(...all.map((b) => b.x - b.w / 2)) + Math.max(...all.map((b) => b.x + b.w / 2))) / 2;
  const middleY =
    (Math.min(...all.map((b) => b.y - b.h / 2)) + Math.max(...all.map((b) => b.y + b.h / 2))) / 2;
  const shift = (b: Box): Point => ({ x: b.x + center.x - middleX, y: b.y + center.y - middleY });
  return { cards: placed.map(shift), notes: noteBoxes.map(shift) };
}

/** Wires: how far a two-way pair bows its two curves apart, in map pixels. */
const WIRE_BOW = 26;
/** Room between a card edge and the arrowhead. */
const WIRE_GAP = 6;

/** Where the ray from the center of `box` toward `toward` leaves the box, plus a gap. */
function boxExit(box: Box, toward: Point, gap: number): Point {
  const dx = toward.x - box.x;
  const dy = toward.y - box.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return box;
  const scale = Math.min(
    dx === 0 ? Infinity : box.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : box.h / 2 / Math.abs(dy),
  );
  return {
    x: box.x + dx * scale + (dx / length) * gap,
    y: box.y + dy * scale + (dy / length) * gap,
  };
}

/**
 * MM-1103: one directed curve from card `a` to card `b`, from edge to edge. `bowed` bends it to
 * the left of its direction, so the two arrows of a two-way pair never cover each other. The
 * badge point sits before the middle, so the badges of a two-way pair sit apart.
 */
export function wireGeometry(a: Box, b: Box, bowed: boolean): { d: string; badge: Point } {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const n = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
  const bow = bowed ? WIRE_BOW * 2 : 0;
  const control = { x: (a.x + b.x) / 2 + n.x * bow, y: (a.y + b.y) / 2 + n.y * bow };
  const start = boxExit(a, control, 0);
  const end = boxExit(b, control, WIRE_GAP);
  const t = bowed ? 0.4 : 0.5;
  const at = (p: number, q: number, r: number) =>
    (1 - t) * (1 - t) * p + 2 * (1 - t) * t * q + t * t * r;
  return {
    d: `M${start.x},${start.y}Q${control.x},${control.y} ${end.x},${end.y}`,
    badge: { x: at(start.x, control.x, end.x), y: at(start.y, control.y, end.y) },
  };
}
