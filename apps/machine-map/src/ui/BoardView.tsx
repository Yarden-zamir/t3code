/**
 * MM-1123 Board: one lane per machine or client, one column per level. Each chip is one arrow of
 * its lane, on the rail of the lane, in the column of its level. A drag moves a chip only along
 * its own lane; ‹ and › do the same with the keyboard.
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type { MachineLevel } from "@t3tools/contracts/machineMap";

import { LEVELS, stepLevel } from "../rules/map.ts";
import { decideProposal, GrantBadges, grantActions } from "./AccessEditor.tsx";
import {
  boardLanes,
  chipsIn,
  columnAt,
  laneMove,
  laneShift,
  returnsTo,
  type BoardChip,
  type BoardLane,
  type ColumnEdge,
} from "./board.ts";
import { usePortalContext, type Portal } from "./context.ts";
import { arrowEnds, grantSelection, type ArrowAsk } from "./derive.ts";
import { LEVEL_LABEL, PRESENCE_STICKER, presenceState, ROLE_TEXT, timeUntil } from "./format.ts";
import { ClientIcon, ClockIcon, KindIcon, PlugIcon, TerminalIcon, TimerIcon } from "./icons.tsx";
import { sameSelection } from "./route.ts";
import { ClientLink, MachineLink } from "./StickerLink.tsx";

/** What each column means, in a few words under its name. */
const COLUMN_TEXT: Record<MachineLevel, string> = {
  none: "cannot connect",
  read: "sees, changes nothing",
  standard: "works there",
  admin: "also manages access",
};

/** The short column names of a phone. */
const COLUMN_SHORT: Record<MachineLevel, string> = {
  none: "None",
  read: "Read",
  standard: "Std",
  admin: "Admin",
};

/** Lane colours cycle through this many CSS classes (`lane-c0` and on). */
const LANE_COLORS = 6;
/** Pointer moves under this many pixels are a tap, not a drag. */
const TAP_PIXELS = 6;

const chipKey = (chip: BoardChip) => `${chip.grant.from.id}>${chip.grant.to.id}`;

/** A chip drag in progress. Moves write the shift straight to the chip, without a render. */
interface Drag {
  readonly lane: string;
  readonly chip: BoardChip;
  readonly element: HTMLElement;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  /** The columns of the lane of the chip, read once when the drag starts. */
  readonly edges: ReadonlyArray<ColumnEdge>;
  /** The center of the chip before the drag, in client pixels. */
  readonly center: number;
  /** Half the width of the chip, so the whole chip stays inside the lane. */
  readonly half: number;
  moved: boolean;
}

/** MM-1123: applies a move of one chip, or says why it does not apply. */
function applyMove(portal: Portal, chip: BoardChip, to: MachineLevel): void {
  const move = laneMove(chip, to, portal.pause !== null);
  const actions = grantActions(portal, chip.grant);
  switch (move._tag) {
    case "stay":
      return;
    case "paused":
      portal.call(() =>
        Promise.reject(new Error("Everything is paused. Access only goes down until you resume.")),
      );
      return;
    case "remove":
      actions.remove();
      return;
    case "set":
      actions.setLevel(move.level, null);
      return;
  }
}

export function BoardView() {
  const portal = usePortalContext();
  const { map, snapshot } = portal;
  const drag = useRef<Drag | null>(null);
  /** A drag that moved ends with a click on its chip. That click is not a tap. */
  const swallowClick = useRef(false);
  /**
   * The chip that a key or a ‹ › press moved. It lands in another column, so React mounts it
   * again; the new chip takes the focus back.
   */
  const refocus = useRef<string | null>(null);
  const markRefocus = (key: string) => {
    refocus.current = key;
  };
  /** True once for the chip that a step moved. */
  const claimRefocus = (key: string): boolean => {
    if (refocus.current !== key) return false;
    refocus.current = null;
    return true;
  };
  /** The lane and the column under a moving chip, so the lane shows its bounds and the target. */
  const [target, setTarget] = useState<{ lane: string; level: MachineLevel } | null>(null);
  const lanes = boardLanes(map, snapshot.proposals, portal.pause);

  const startDrag = (event: PointerEvent<HTMLElement>, lane: BoardLane, chip: BoardChip) => {
    swallowClick.current = false;
    if (event.button !== 0 || chip.cut !== null) return;
    if (event.target instanceof Element && event.target.closest(".step")) return;
    const element = event.currentTarget;
    const track = element.closest(".lane-track");
    if (!track) return;
    const edges = LEVELS.map((level) => {
      const cell = track.querySelector(`[data-column="${level}"]`)?.getBoundingClientRect();
      if (!cell) throw new Error(`The lane has no ${level} column.`);
      return { left: cell.left, right: cell.right };
    });
    const box = element.getBoundingClientRect();
    // The chip takes the pointer only once it moves, so a tap still reaches its buttons. A press
    // that ends off the chip before that ends here.
    const forget = (up: globalThis.PointerEvent) => {
      if (up.pointerId !== event.pointerId) return;
      if (drag.current?.pointerId === up.pointerId && !drag.current.moved) drag.current = null;
      removeEventListener("pointerup", forget);
      removeEventListener("pointercancel", forget);
    };
    addEventListener("pointerup", forget);
    addEventListener("pointercancel", forget);
    drag.current = {
      lane: lane.key,
      chip,
      element,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      edges,
      center: box.left + box.width / 2,
      half: box.width / 2,
      moved: false,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    if (!current.moved) {
      const dy = event.clientY - current.startY;
      // A mostly vertical move scrolls the page; the chip stays.
      if (Math.abs(dy) > TAP_PIXELS && Math.abs(dy) > Math.abs(dx)) {
        drag.current = null;
        return;
      }
      if (Math.abs(dx) <= TAP_PIXELS) return;
      current.moved = true;
      current.element.setPointerCapture(current.pointerId);
      current.element.classList.add("dragging");
    }
    const shift = laneShift(current.edges, current.center, current.half, dx);
    current.element.style.transform = `translateX(${shift}px)`;
    const level = columnAt(current.edges, current.center + shift);
    setTarget((was) =>
      was?.lane === current.lane && was.level === level ? was : { lane: current.lane, level },
    );
  };

  /** Ends the drag. The chip goes back to its column; the new level arrives with the map. */
  const endDrag = (event: PointerEvent<HTMLElement>, drop: boolean) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!current.moved) return;
    current.element.style.transform = "";
    current.element.classList.remove("dragging");
    setTarget(null);
    swallowClick.current = true;
    if (!drop) return;
    const shift = laneShift(
      current.edges,
      current.center,
      current.half,
      event.clientX - current.startX,
    );
    applyMove(portal, current.chip, columnAt(current.edges, current.center + shift));
  };

  if (map.machines.length === 0)
    return (
      <div className="card view">
        <div className="empty">
          <h3>No machines yet</h3>
          <p>Add a machine. Its arrows show here, one row for each machine.</p>
        </div>
      </div>
    );

  return (
    <div className="card view board">
      <div className="board-head">
        <h2>Who uses whom</h2>
        <p className="small muted">
          Each row is one machine or client and the machines that it uses. A chip sits in the column
          of its level. Drag a chip along its row, or use ‹ and ›, to change the level. Open a chip
          for agent tools, exec and time limits.
        </p>
        <p className="legend small">
          <span>
            <PlugIcon /> agent tools
          </span>
          <span>
            <TerminalIcon /> exec
          </span>
          <span>
            <TimerIcon /> temporary
          </span>
          <span>
            <span className="ask-chip-sample">dashed</span> waits for you
          </span>
        </p>
      </div>
      <div className="board-grid" role="table" aria-label="Who uses whom, by level">
        <div className="board-row board-columns" role="row">
          <div className="lane-title" role="columnheader">
            Row uses
          </div>
          <div className="lane-track">
            {LEVELS.map((level) => (
              <div key={level} className="column-head" role="columnheader">
                <span className={`lvl-pill lvl-${level}`}>
                  <span className="long">{LEVEL_LABEL[level]}</span>
                  <span className="short">{COLUMN_SHORT[level]}</span>
                </span>
                <span className="small muted">{COLUMN_TEXT[level]}</span>
              </div>
            ))}
          </div>
        </div>
        {lanes.map((lane, index) => (
          <div
            key={lane.key}
            role="row"
            className={`board-row lane lane-c${index % LANE_COLORS}${target?.lane === lane.key ? " moving" : ""}`}
          >
            <LaneTitle lane={lane} />
            <div className="lane-track">
              {LEVELS.map((level) => (
                <div
                  key={level}
                  role="cell"
                  data-column={level}
                  data-level={LEVEL_LABEL[level]}
                  aria-label={`${lane.name} uses, ${LEVEL_LABEL[level]}`}
                  className={`board-cell col-${level}${target?.lane === lane.key && target.level === level ? " over" : ""}`}
                >
                  {chipsIn(lane, level).map((chip) => (
                    <Chip
                      key={chipKey(chip)}
                      chip={chip}
                      onPointerDown={(event) => startDrag(event, lane, chip)}
                      onPointerMove={onPointerMove}
                      onPointerUp={(event) => endDrag(event, true)}
                      onPointerCancel={(event) => endDrag(event, false)}
                      onLostPointerCapture={(event) => endDrag(event, false)}
                      markRefocus={markRefocus}
                      claimRefocus={claimRefocus}
                      onClickCapture={(event: MouseEvent) => {
                        if (!swallowClick.current) return;
                        swallowClick.current = false;
                        event.stopPropagation();
                        event.preventDefault();
                      }}
                    />
                  ))}
                  {lane.asks
                    .filter((ask) => ask.arrow.level === level)
                    .map((ask) => (
                      <AskChip key={`${ask.proposal.id}>${ask.arrow.to}`} ask={ask} />
                    ))}
                  {returnsTo(lane, level).map((chip) => (
                    <span
                      key={chipKey(chip)}
                      className="return-chip"
                      data-tip={`${chip.grant.to.name} comes back to this column when its time ends`}
                    >
                      <TimerIcon />
                      {chip.grant.to.name} <span className="long">back here</span>{" "}
                      {chip.grant.arrow.expiresAt &&
                        timeUntil(chip.grant.arrow.expiresAt, portal.now)}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** "Mac uses": the source of the lane, in the colour of its rail. */
function LaneTitle({ lane }: { lane: BoardLane }) {
  const portal = usePortalContext();
  const source = lane.source;
  const state =
    source._tag === "machine" ? presenceState(portal.snapshot.presence[source.machine.id]) : null;
  return (
    <div className="lane-title" role="rowheader">
      <span className="lane-name">
        <span className="lane-swatch" aria-hidden>
          {source._tag === "machine" ? <KindIcon kind={source.machine.kind} /> : <ClientIcon />}
        </span>
        {source._tag === "machine" ? (
          <MachineLink id={source.machine.id}>{lane.name}</MachineLink>
        ) : (
          <ClientLink id={source.client.id}>{lane.name}</ClientLink>
        )}
        <span className="verb">uses</span>
      </span>
      <span className="lane-facts">
        {state && <span className={`sticker flat ${PRESENCE_STICKER[state]}`}>{state}</span>}
        {source._tag === "machine" && source.machine.mapRole !== "none" && (
          <span className="small muted" data-tip={ROLE_TEXT[source.machine.mapRole]}>
            map {source.machine.mapRole}
          </span>
        )}
        {source._tag === "client" && <span className="small muted">client</span>}
      </span>
    </div>
  );
}

/** One arrow of a lane. ‹ and › move it one column; a tap opens it. */
function Chip({
  chip,
  markRefocus,
  claimRefocus,
  ...pointer
}: {
  chip: BoardChip;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onClickCapture: (event: MouseEvent) => void;
  onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
  markRefocus: (key: string) => void;
  claimRefocus: (key: string) => boolean;
}) {
  const portal = usePortalContext();
  const { grant, cut } = chip;
  const target = grantSelection(grant);
  const on = sameSelection(portal.route.selection, target);
  const ends =
    grant._tag === "machine" ? arrowEnds(portal.snapshot, grant.from.id, grant.to.id) : null;
  const waiting = ends !== null && (ends.from !== "applied" || ends.to !== "applied");
  const paused = portal.pause !== null;
  const down = cut === null ? stepLevel(grant.arrow.level, -1) : null;
  const up = cut === null ? stepLevel(grant.arrow.level, 1) : null;
  const canUp = up !== null && !paused;
  const name = `${grant.from.name} uses ${grant.to.name}`;
  const nameRef = useRef<HTMLButtonElement>(null);
  const key = chipKey(chip);
  useEffect(() => {
    if (claimRefocus(key)) nameRef.current?.focus();
  });
  /** A key or a ‹ › press: the chip moves one column and keeps the focus. */
  const step = (to: MachineLevel) => {
    markRefocus(key);
    applyMove(portal, chip, to);
  };
  const onKey = (event: KeyboardEvent) => {
    const to = event.key === "ArrowLeft" ? down : event.key === "ArrowRight" && canUp ? up : null;
    if (to === null) return;
    event.preventDefault();
    step(to);
  };
  return (
    <div
      className={`chip${grant.arrow.level === "none" && cut === null ? " off" : ""}${on ? " on" : ""}${cut ? " cut" : ""}`}
      {...pointer}
    >
      <button
        type="button"
        className="step"
        aria-label={
          down ? `Lower ${name} to ${LEVEL_LABEL[down]}` : `${name} is at the lowest level`
        }
        disabled={down === null}
        onClick={() => down && step(down)}
      >
        ‹
      </button>
      <button
        ref={nameRef}
        type="button"
        className="chip-name"
        aria-label={`${name}: ${cut ? `cut by the pause, was ${LEVEL_LABEL[cut]}` : LEVEL_LABEL[grant.arrow.level]}`}
        aria-keyshortcuts="ArrowLeft ArrowRight"
        onClick={() => portal.select(target)}
        onKeyDown={onKey}
      >
        <span className="chip-from" aria-hidden>
          →
        </span>
        <span className="chip-to">
          <KindIcon kind={grant.to.kind} />
          {grant.to.name}
        </span>
        {grant.arrow.level !== "none" && (
          <span className="no-level">
            <GrantBadges grant={grant} now={portal.now} short />
          </span>
        )}
        {cut && <span className="cut-word">cut</span>}
        {waiting && <ClockIcon label="Waits for a machine to apply it" />}
      </button>
      <button
        type="button"
        className="step"
        aria-label={up ? `Raise ${name} to ${LEVEL_LABEL[up]}` : `${name} is at the highest level`}
        disabled={!canUp}
        onClick={() => up && step(up)}
      >
        ›
      </button>
    </div>
  );
}

/** MM-804: a proposal sits as a dashed chip in the column that it asks for, with ✓ and ✕. */
function AskChip({ ask }: { ask: ArrowAsk }) {
  const portal = usePortalContext();
  const from = portal.map.machines.find((m) => m.id === ask.arrow.from);
  const to = portal.map.machines.find((m) => m.id === ask.arrow.to);
  if (!from || !to) return null;
  const name = `${from.name} uses ${to.name}: ${LEVEL_LABEL[ask.arrow.level]}`;
  return (
    <div className="chip ask-chip" data-tip={ask.proposal.summary}>
      <button
        type="button"
        className="chip-name"
        aria-label={`${name}, asked by an agent`}
        onClick={() => portal.select({ _tag: "arrow", from: from.id, to: to.id })}
      >
        <span className="chip-from" aria-hidden>
          →
        </span>
        <span className="chip-to">
          <KindIcon kind={to.kind} />
          {to.name}
        </span>
        {ask.arrow.agentTools && <PlugIcon />}
        {ask.arrow.exec && <TerminalIcon />}
        <span className="ask-word">asks</span>
      </button>
      {ask.proposal.changes.length > 1 ? (
        // MM-804: Approve decides the whole proposal, so one with more changes opens first.
        <button
          type="button"
          className="step more"
          aria-label={`Open the proposal: ${ask.proposal.changes.length} changes`}
          data-tip={`${ask.proposal.changes.length} changes in one proposal`}
          onClick={() => portal.select({ _tag: "proposal", id: ask.proposal.id }, "inbox")}
        >
          +{ask.proposal.changes.length - 1}
        </button>
      ) : (
        <>
          <button
            type="button"
            className="step yes"
            aria-label={`Approve ${name}`}
            onClick={() => decideProposal(portal, ask.proposal.id, "approve")}
          >
            ✓
          </button>
          <button
            type="button"
            className="step no"
            aria-label={`Reject ${name}`}
            onClick={() => decideProposal(portal, ask.proposal.id, "reject")}
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}
