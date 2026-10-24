import type { GhosttyCell } from "./core";
import type { GhosttyCellMetrics } from "./renderer";

/**
 * Fork: the powerline outlines and half circles (U+E0B1, U+E0B3 to U+E0B7) are drawn as shapes
 * that fill the whole cell, as Ghostty does. A font draws them at its own size, so they do not
 * meet the segments next to them. The renderer already draws the solid triangles (U+E0B0, U+E0B2)
 * this way. Limit: not the diagonal and flame variants; revisit if a prompt theme uses U+E0B8 and
 * above.
 */
const FORK_POWERLINE_CODEPOINTS: ReadonlySet<number> = new Set([
  0xe0b1, 0xe0b3, 0xe0b4, 0xe0b5, 0xe0b6, 0xe0b7,
]);

function forkPowerlineCodepoint(text: string): number | null {
  const codepoint = text.codePointAt(0);
  if (codepoint === undefined || text.length !== 1) return null;
  return FORK_POWERLINE_CODEPOINTS.has(codepoint) ? codepoint : null;
}

/** The text of a cell in a text run: a space where `forkDrawPowerlines` draws the cell. */
export function forkPowerlineText(text: string): string {
  return forkPowerlineCodepoint(text) === null ? text : " ";
}

/** Draws the fork powerline cells of the text run `start` to `end`, in the color of the run. */
export function forkDrawPowerlines(
  context: CanvasRenderingContext2D,
  cells: readonly GhosttyCell[],
  start: number,
  end: number,
  padding: number,
  top: number,
  metrics: GhosttyCellMetrics,
): void {
  const first = cells[start];
  if (!first || first.invisible) return;
  const color = `rgb(${first.foreground.r}, ${first.foreground.g}, ${first.foreground.b})`;
  for (let column = start; column < end; column += 1) {
    const codepoint = forkPowerlineCodepoint(cells[column]?.text ?? "");
    if (codepoint === null) continue;
    context.fillStyle = color;
    context.strokeStyle = color;
    drawPowerline(context, codepoint, padding + column * metrics.width, top, metrics);
  }
}

function drawPowerline(
  context: CanvasRenderingContext2D,
  codepoint: number,
  left: number,
  top: number,
  { width, height }: GhosttyCellMetrics,
): void {
  // One pixel of overlap on the open side hides the seam against the neighbouring cell.
  const overlap = 1;
  const pointsRight = codepoint === 0xe0b1 || codepoint === 0xe0b4 || codepoint === 0xe0b5;
  const outline = codepoint % 2 === 1;
  const baseX = pointsRight ? left - overlap : left + width + overlap;
  const tipX = pointsRight ? left + width : left;
  context.beginPath();
  context.moveTo(baseX, top);
  if (codepoint <= 0xe0b3) {
    context.lineTo(tipX, top + height / 2);
    context.lineTo(baseX, top + height);
  } else {
    context.bezierCurveTo(tipX, top, tipX, top + height, baseX, top + height);
  }
  if (outline) {
    context.lineWidth = Math.max(1, Math.round(width / 8));
    context.stroke();
  } else {
    context.closePath();
    context.fill();
  }
}
