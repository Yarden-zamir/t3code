/**
 * The Board of the Table view (MM-1102, MM-1123): one lane per source, one column per level. Each
 * chip is one arrow of its lane, so its column is its level. A chip moves only along its own lane.
 */
import type {
  ClientRecord,
  MachineLevel,
  MachineMapDocument,
  MachineRecord,
  MapProposal,
} from "@t3tools/contracts/machineMap";

import type { PauseView } from "../api.ts";
import { findArrow, findClientArrow, LEVELS, levelRank } from "../rules/map.ts";
import { arrowAsks, grantCut, type ArrowAsk, type Grant } from "./derive.ts";

/** One arrow of a lane, in the column of its level. */
export interface BoardChip {
  readonly grant: Grant;
  /** The column: the level, or for an arrow that the pause cut, the level before the pause. */
  readonly column: MachineLevel;
  /** MM-717: the level before the pause, for an arrow that the pause cut. */
  readonly cut: MachineLevel | null;
}

/** One source: a machine or a client, and every machine that it can use. */
export interface BoardLane {
  readonly key: string;
  readonly source:
    | { readonly _tag: "machine"; readonly machine: MachineRecord }
    | { readonly _tag: "client"; readonly client: ClientRecord };
  readonly name: string;
  readonly chips: ReadonlyArray<BoardChip>;
  /** MM-804: proposals of this lane, in the column that they ask for. */
  readonly asks: ReadonlyArray<ArrowAsk>;
}

const chip = (grant: Grant, pause: PauseView | null): BoardChip => {
  const cut = grantCut(pause, grant);
  return { grant, column: cut ?? grant.arrow.level, cut };
};

/** Machines first, then clients. A machine lane holds every other machine, a client lane every machine. */
export function boardLanes(
  map: MachineMapDocument,
  proposals: ReadonlyArray<MapProposal>,
  pause: PauseView | null,
): ReadonlyArray<BoardLane> {
  return [
    ...map.machines.map((from): BoardLane => ({
      key: `machine:${from.id}`,
      source: { _tag: "machine", machine: from },
      name: from.name,
      chips: map.machines
        .filter((to) => to.id !== from.id)
        .map((to) =>
          chip({ _tag: "machine", from, to, arrow: findArrow(map, from.id, to.id) }, pause),
        ),
      asks: map.machines.flatMap((to) => arrowAsks(proposals, from.id, to.id)),
    })),
    ...map.clients.map((from): BoardLane => ({
      key: `client:${from.id}`,
      source: { _tag: "client", client: from },
      name: from.name,
      chips: map.machines.map((to) =>
        chip({ _tag: "client", from, to, arrow: findClientArrow(map, from.id, to.id) }, pause),
      ),
      asks: [],
    })),
  ];
}

/** The chips that a lane shows in one column. */
export const chipsIn = (lane: BoardLane, level: MachineLevel): ReadonlyArray<BoardChip> =>
  lane.chips.filter((c) => c.column === level);

/** MM-304: the chips of a lane that return to `level` when their time ends. */
export const returnsTo = (lane: BoardLane, level: MachineLevel): ReadonlyArray<BoardChip> =>
  lane.chips.filter((c) => c.grant.arrow.expiresAt !== null && c.grant.arrow.revertLevel === level);

/** The left and right edge of one column of a lane, in client pixels. */
export interface ColumnEdge {
  readonly left: number;
  readonly right: number;
}

/**
 * The column under the pointer `x`. It reads only the columns of the lane of the chip, and a
 * pointer past either end takes the end column, so a drag never leaves its lane. The columns are
 * in level order: `edges[0]` is None.
 */
export function columnAt(edges: ReadonlyArray<ColumnEdge>, x: number): MachineLevel {
  if (edges.length !== LEVELS.length) throw new Error("A lane has one column per level.");
  const index = edges.findIndex((edge) => x < edge.right);
  const level = LEVELS[index === -1 ? LEVELS.length - 1 : index];
  if (level === undefined) throw new Error("A lane has one column per level.");
  return level;
}

/** How far a dragged chip may move: its center stays inside the lane. */
export function laneShift(edges: ReadonlyArray<ColumnEdge>, center: number, dx: number): number {
  const first = edges[0];
  const last = edges.at(-1);
  if (!first || !last) return 0;
  return Math.min(last.right - center, Math.max(first.left - center, dx));
}

/** What a move of a chip to a column does. */
export type LaneMove =
  /** The chip stays: same column, or an arrow that the pause cut. */
  | { readonly _tag: "stay" }
  /** MM-711: while paused, access only goes down. */
  | { readonly _tag: "paused" }
  /** Level `none` and no agent tools: the arrow leaves the map. */
  | { readonly _tag: "remove" }
  /** A permanent level. A temporary level ends. */
  | { readonly _tag: "set"; readonly level: MachineLevel };

export function laneMove(chip: BoardChip, to: MachineLevel, paused: boolean): LaneMove {
  // A cut arrow is at `none`; every move would raise it, and Resume returns it.
  if (chip.cut !== null || to === chip.column) return { _tag: "stay" };
  if (paused && levelRank(to) > levelRank(chip.grant.arrow.level)) return { _tag: "paused" };
  return to === "none" ? { _tag: "remove" } : { _tag: "set", level: to };
}
