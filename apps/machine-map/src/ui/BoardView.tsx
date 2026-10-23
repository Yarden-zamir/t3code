/**
 * Board design: one lane per machine or client that uses others, one column per level. The column
 * of a chip is its level, so level and agent capabilities never look alike. Moving a chip one
 * column raises or lowers the arrow; "No access" is the way out.
 */
import { useState, type DragEvent } from "react";
import type { MachineLevel } from "@t3tools/contracts/machineMap";

import type { PauseView } from "../api.ts";
import { findArrow, findClientArrow, LEVELS } from "../rules/map.ts";
import { decideProposal, GrantBadges, grantActions, stepLevel } from "./AccessEditor.tsx";
import { usePortalContext } from "./context.ts";
import {
  arrowAsks,
  arrowEnds,
  cutLevel,
  grantSelection,
  type ArrowAsk,
  type Grant,
} from "./derive.ts";
import { LEVEL_LABEL, PRESENCE_STICKER, presenceState, ROLE_TEXT, timeUntil } from "./format.ts";
import { sameSelection } from "./route.ts";
import { ClientIcon, ClockIcon, KindIcon, PlugIcon, TerminalIcon, TimerIcon } from "./icons.tsx";

/** What each column means, in a few words under its name. */
const COLUMN_TEXT: Record<MachineLevel, string> = {
  none: "cannot connect",
  read: "sees, changes nothing",
  standard: "works there",
  admin: "also manages access",
};

/** The chip that a drag carries, by its grant key. */
const DRAG_TYPE = "application/x-machine-map-grant";

const grantKey = (grant: Grant) => `${grant._tag}:${grant.from.id}>${grant.to.id}`;

export function BoardView() {
  const portal = usePortalContext();
  const { map, snapshot } = portal;
  const [over, setOver] = useState<string | null>(null);

  const lanes = [
    ...map.machines.map((from) => ({
      key: `machine:${from.id}`,
      title: from.name,
      icon: <KindIcon kind={from.kind} />,
      presence: presenceState(snapshot.presence[from.id]),
      role: from.mapRole,
      machineId: from.id,
      grants: map.machines
        .filter((to) => to.id !== from.id)
        .map((to): Grant => ({ _tag: "machine", from, to, arrow: findArrow(map, from.id, to.id) })),
    })),
    ...map.clients.map((from) => ({
      key: `client:${from.id}`,
      title: from.name,
      icon: <ClientIcon />,
      presence: null,
      role: null,
      machineId: null,
      grants: map.machines.map((to): Grant => ({
        _tag: "client",
        from,
        to,
        arrow: findClientArrow(map, from.id, to.id),
      })),
    })),
  ];
  const byKey = new Map(lanes.flatMap((lane) => lane.grants.map((g) => [grantKey(g), g])));

  const drop = (event: DragEvent, level: MachineLevel) => {
    event.preventDefault();
    setOver(null);
    const grant = byKey.get(event.dataTransfer.getData(DRAG_TYPE));
    if (!grant || grant.arrow.level === level) return;
    const actions = grantActions(portal, grant);
    if (level === "none") actions.remove();
    else if (actions.canRaise(level)) actions.setLevel(level, null);
  };

  return (
    <div className="card view board">
      <div className="board-head">
        <h2>Who uses whom</h2>
        <p className="small muted">
          Each lane is a machine or a client. Its chips are the machines it uses, in the column of
          their level. Drag a chip or use its arrows to raise or lower. Open a chip for agent tools,
          exec and time limits.
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
          <span className="ask-chip-sample">dashed</span> waits for your approval
        </p>
      </div>
      <div className="board-grid" role="table" aria-label="Arrows by level">
        <div className="board-row board-columns" role="row">
          <div className="lane-title" role="columnheader">
            Uses
          </div>
          {LEVELS.map((level) => (
            <div key={level} className={`column-head col-${level}`} role="columnheader">
              <span className={`lvl-pill lvl-${level}`}>{LEVEL_LABEL[level]}</span>
              <span className="small muted">{COLUMN_TEXT[level]}</span>
            </div>
          ))}
        </div>
        {lanes.map((lane) => (
          <div className="board-row lane" role="row" key={lane.key}>
            <div className="lane-title" role="rowheader">
              <button
                type="button"
                className="lane-name"
                onClick={() =>
                  portal.select(
                    lane.machineId
                      ? { _tag: "machine", id: lane.machineId }
                      : { _tag: "client", id: lane.key.slice("client:".length) },
                  )
                }
              >
                <span className="icon">{lane.icon}</span>
                {lane.title}
              </button>
              {lane.presence && (
                <span className={`sticker flat ${PRESENCE_STICKER[lane.presence]}`}>
                  {lane.presence}
                </span>
              )}
              {lane.role && lane.role !== "none" && (
                <span className="small muted" data-tip={ROLE_TEXT[lane.role]}>
                  map: {lane.role}
                </span>
              )}
              {!lane.machineId && <span className="small muted">client, no agents</span>}
            </div>
            {LEVELS.map((level) => {
              const cellKey = `${lane.key}:${level}`;
              const here = lane.grants.filter((g) => shownLevel(g, portal.pause) === level);
              const asks = lane.grants.flatMap((g) =>
                g._tag === "machine"
                  ? arrowAsks(snapshot.proposals, g.from.id, g.to.id).filter(
                      (ask) => ask.arrow.level === level,
                    )
                  : [],
              );
              const returning = lane.grants.filter(
                (g) => g.arrow.expiresAt && g.arrow.revertLevel === level,
              );
              return (
                <div
                  key={level}
                  role="cell"
                  className={`board-cell col-${level}${over === cellKey ? " over" : ""}`}
                  data-level={LEVEL_LABEL[level]}
                  aria-label={`${lane.title}, ${LEVEL_LABEL[level]}`}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
                    event.preventDefault();
                    setOver(cellKey);
                  }}
                  onDragLeave={() => setOver((current) => (current === cellKey ? null : current))}
                  onDrop={(event) => drop(event, level)}
                >
                  {here.map((grant) => (
                    <Chip key={grantKey(grant)} grant={grant} />
                  ))}
                  {asks.map((ask) => (
                    <AskChip key={ask.proposal.id} ask={ask} />
                  ))}
                  {returning.map((grant) => (
                    <span
                      key={grantKey(grant)}
                      className="chip return-chip"
                      data-tip={`${grant.to.name} comes back here when the time ends`}
                    >
                      <TimerIcon />
                      {grant.to.name}{" "}
                      {grant.arrow.expiresAt && timeUntil(grant.arrow.expiresAt, portal.now)}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** MM-717: a cut arrow stays in the column of its level before the pause, marked cut. */
function shownLevel(grant: Grant, pause: PauseView | null): MachineLevel {
  if (grant._tag !== "machine" || grant.arrow.level !== "none") return grant.arrow.level;
  return cutLevel(pause, grant.from.id, grant.to.id) ?? "none";
}

/** One machine that the lane uses. The arrows move it one column; a click opens it. */
function Chip({ grant }: { grant: Grant }) {
  const portal = usePortalContext();
  const actions = grantActions(portal, grant);
  const { arrow } = grant;
  const target = grantSelection(grant);
  const on = sameSelection(portal.route.selection, target);
  const ends =
    grant._tag === "machine" ? arrowEnds(portal.snapshot, grant.from.id, grant.to.id) : null;
  const waiting = ends !== null && (ends.from !== "applied" || ends.to !== "applied");
  const cut =
    grant._tag === "machine" && arrow.level === "none"
      ? cutLevel(portal.pause, grant.from.id, grant.to.id)
      : null;
  const empty = arrow.level === "none" && !(grant._tag === "machine" && grant.arrow.agentTools);
  const down = stepLevel(arrow.level, -1);
  const up = stepLevel(arrow.level, 1);
  return (
    <div
      className={`chip${empty ? " off" : ""}${on ? " on" : ""}${cut ? " cut" : ""}`}
      draggable={!cut}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, grantKey(grant));
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <button
        type="button"
        className="step"
        aria-label={down ? `Lower to ${LEVEL_LABEL[down]}` : "Lowest level"}
        disabled={down === null}
        onClick={() => (down === "none" ? actions.remove() : actions.step(-1))}
      >
        ‹
      </button>
      <button
        type="button"
        className="chip-name"
        onClick={() => portal.select(target)}
        aria-label={`${grant.from.name} uses ${grant.to.name}: ${LEVEL_LABEL[arrow.level]}`}
      >
        <KindIcon kind={grant.to.kind} />
        {grant.to.name}
        {!empty && arrow.level !== "none" && <GrantBadgesWithoutLevel grant={grant} />}
        {cut && <span className="cut-word">cut</span>}
        {waiting && <ClockIcon label="Waits for a machine to apply it" />}
      </button>
      <button
        type="button"
        className="step"
        aria-label={up ? `Raise to ${LEVEL_LABEL[up]}` : "Highest level"}
        disabled={up === null || !actions.canRaise(up)}
        onClick={() => actions.step(1)}
      >
        ›
      </button>
    </div>
  );
}

/** The column already says the level, so the chip shows only the icons. */
function GrantBadgesWithoutLevel({ grant }: { grant: Grant }) {
  const portal = usePortalContext();
  return (
    <span className="no-level">
      <GrantBadges grant={grant} now={portal.now} short />
    </span>
  );
}

/** MM-804: a proposal sits as a dashed chip in the column that it asks for. */
function AskChip({ ask }: { ask: ArrowAsk }) {
  const portal = usePortalContext();
  const to = portal.map.machines.find((m) => m.id === ask.arrow.to);
  if (!to) return null;
  return (
    <div className="chip ask-chip" data-tip={ask.proposal.summary}>
      <button
        type="button"
        className="chip-name"
        onClick={() => portal.select({ _tag: "arrow", from: ask.arrow.from, to: ask.arrow.to })}
      >
        <KindIcon kind={to.kind} />
        {to.name}
        {ask.arrow.agentTools && <PlugIcon />}
        {ask.arrow.exec && <TerminalIcon />}
        <span className="small">asks</span>
      </button>
      <button
        type="button"
        className="step yes"
        aria-label="Approve"
        onClick={() => decideProposal(portal, ask.proposal.id, "approve")}
      >
        ✓
      </button>
      <button
        type="button"
        className="step no"
        aria-label="Reject"
        onClick={() => decideProposal(portal, ask.proposal.id, "reject")}
      >
        ✕
      </button>
    </div>
  );
}
