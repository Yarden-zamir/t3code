/**
 * Design "ribbon": the geometry of one-way lanes. Each arrow is its own line from the edge of the
 * source card to the edge of the target card, moved a little to its right, so the two directions
 * of a pair run side by side and never share a line. A chip sits on the lane near the target.
 */
import type { Box, Point } from "../layout.ts";

/** Half the distance between the two lanes of a pair, in map pixels. */
export const LANE_GAP = 9;
/** Where the chip sits along the lane: past the middle, toward the target it describes. */
const CHIP_ALONG = 0.68;
/** Room between the card edge and the arrowhead, so the head never hides under the card. */
const HEAD_ROOM = 3;

/** The point where the ray from the center of `box` toward `toward` leaves the box. */
export function edgePoint(box: Box, toward: Point): Point {
  const dx = toward.x - box.x;
  const dy = toward.y - box.y;
  if (dx === 0 && dy === 0) return { x: box.x, y: box.y };
  const halfW = box.w / 2 + HEAD_ROOM;
  const halfH = box.h / 2 + HEAD_ROOM;
  const scale = Math.min(
    dx === 0 ? Infinity : halfW / Math.abs(dx),
    dy === 0 ? Infinity : halfH / Math.abs(dy),
  );
  return { x: box.x + dx * scale, y: box.y + dy * scale };
}

interface Lane {
  readonly d: string;
  readonly chip: Point;
  /** The angle of the lane in degrees, for a chip that wants to follow it. */
  readonly angle: number;
}

/** The lane from `from` to `to`, shifted `gap` pixels to its right. `gap` 0 keeps the center. */
export function lane(from: Box, to: Box, gap = LANE_GAP): Lane {
  const a = { x: from.x, y: from.y };
  const b = { x: to.x, y: to.y };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  // The right-hand normal of the travel direction, in screen coordinates (y grows down).
  const nx = (-dy / length) * gap;
  const ny = (dx / length) * gap;
  const shift = (p: Point): Point => ({ x: p.x + nx, y: p.y + ny });
  const start = shift(edgePoint(from, b));
  const end = shift(edgePoint(to, a));
  const chip = {
    x: start.x + (end.x - start.x) * CHIP_ALONG,
    y: start.y + (end.y - start.y) * CHIP_ALONG,
  };
  return {
    d: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
    chip,
    angle: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}
