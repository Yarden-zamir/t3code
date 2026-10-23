/**
 * Design "board": a from-by-to board of access chips instead of the graph. Each row is a source
 * (a machine, then each client), each column a target machine. A chip holds the whole state of
 * one arrow. A tap opens the editor under the row. Proposals wait in a strip above the board.
 */
import { useState } from "react";
import type { ClientRecord, MachineRecord, MapProposal } from "@t3tools/contracts/machineMap";

import { usesText } from "../../rules/access.ts";
import { findArrow, findClientArrow, MAP_ROLES, roleRank } from "../../rules/map.ts";
import { usePortalContext } from "../context.ts";
import { arrowEnds, arrowProposals, cutLevel, describeChange } from "../derive.ts";
import {
  actorText,
  LEVEL_LABEL,
  PRESENCE_STICKER,
  presenceState,
  timeAgo,
  timeUntil,
} from "../format.ts";
import { ClientIcon, ClockIcon, KindIcon, RobotIcon } from "../icons.tsx";
import { MachineLink } from "../StickerLink.tsx";
import { ArrowEditor, ClientArrowEditor, ProposalActions } from "./ArrowControls.tsx";

type Source =
  | { readonly _tag: "machine"; readonly machine: MachineRecord }
  | { readonly _tag: "client"; readonly client: ClientRecord };

const sourceId = (source: Source) =>
  source._tag === "machine" ? source.machine.id : source.client.id;
const sourceName = (source: Source) =>
  source._tag === "machine" ? source.machine.name : source.client.name;

/** MM-804: every proposal in one strip, so nothing waits unseen. */
function ProposalStrip({ proposals }: { proposals: ReadonlyArray<MapProposal> }) {
  const portal = usePortalContext();
  if (proposals.length === 0) return null;
  return (
    <div className="card board-proposals">
      <div className="row">
        <span className="sticker wait">inbox</span>
        <b className="grow">
          {proposals.length === 1
            ? "1 proposal waits for you"
            : `${proposals.length} proposals wait for you`}
        </b>
      </div>
      {proposals.map((proposal) => (
        <div className="row proposal-line" key={proposal.id}>
          <span className="grow">
            <span className="t">{proposal.summary}</span>
            <span className="v">
              {actorText(proposal.actor, portal.map)} · {timeAgo(proposal.at, portal.now)} · expires{" "}
              {timeUntil(proposal.expiresAt, portal.now)}
              {proposal.changes.length > 1 && (
                <>
                  {" · "}
                  {proposal.changes.map((change) => describeChange(change, portal.map)).join("; ")}
                </>
              )}
            </span>
          </span>
          <ProposalActions proposal={proposal} />
        </div>
      ))}
    </div>
  );
}

/** One chip: the level, then one mark for each thing that changes what the level alone says. */
function Chip({
  source,
  to,
  open,
  onOpen,
}: {
  source: Source;
  to: MachineRecord;
  open: boolean;
  onOpen: () => void;
}) {
  const portal = usePortalContext();
  const { map, snapshot, now } = portal;
  const name = sourceName(source);
  if (source._tag === "client") {
    const arrow = findClientArrow(map, source.client.id, to.id);
    const was =
      arrow.level === "none"
        ? (portal.pause?.cutClients.find((c) => c.client === source.client.id && c.to === to.id)
            ?.level ?? null)
        : null;
    const level = was ?? arrow.level;
    return (
      <button
        type="button"
        className={`chip lvl-${level}${was ? " cut" : ""}${open ? " open" : ""}`}
        aria-pressed={open}
        aria-label={`${usesText(name, to.name)}: ${LEVEL_LABEL[level]}`}
        onClick={onOpen}
      >
        <span className="chip-target">{to.name}</span>
        <span className="chip-level">{LEVEL_LABEL[level]}</span>
        <span className="chip-marks">
          {was && <span className="mark cut">cut</span>}
          {arrow.expiresAt && (
            <span className="mark temp" data-tip={`Until ${timeUntil(arrow.expiresAt, now)}`}>
              <ClockIcon label="temporary" /> {timeUntil(arrow.expiresAt, now)}
            </span>
          )}
        </span>
      </button>
    );
  }
  const from = source.machine;
  const arrow = findArrow(map, from.id, to.id);
  const was = arrow.level === "none" ? cutLevel(portal.pause, from.id, to.id) : null;
  const level = was ?? arrow.level;
  const proposals = arrowProposals(snapshot, from.id, to.id);
  const ends = arrowEnds(snapshot, from.id, to.id);
  const queued = ends.from !== "applied" || ends.to !== "applied";
  return (
    <button
      type="button"
      className={`chip lvl-${level}${was ? " cut" : ""}${open ? " open" : ""}${proposals.length > 0 ? " proposed" : ""}`}
      aria-pressed={open}
      aria-label={`${usesText(from.name, to.name)}: ${LEVEL_LABEL[level]}`}
      onClick={onOpen}
    >
      <span className="chip-target">{to.name}</span>
      <span className="chip-level">{LEVEL_LABEL[level]}</span>
      <span className="chip-marks">
        {was && <span className="mark cut">cut</span>}
        {arrow.agentTools && (
          <span className="mark" data-tip="Agent tools: agents call T3 tools here">
            <RobotIcon /> tools
          </span>
        )}
        {arrow.exec && (
          <span className="mark" data-tip="Exec: agents run shell commands here">
            exec
          </span>
        )}
        {arrow.expiresAt && arrow.revertLevel && (
          <span
            className="mark temp"
            data-tip={`Back to ${LEVEL_LABEL[arrow.revertLevel]} ${timeUntil(arrow.expiresAt, now)}`}
          >
            <ClockIcon label="temporary" /> {timeUntil(arrow.expiresAt, now)}
          </span>
        )}
        {queued && (
          <span className="mark wait" data-tip="A machine did not apply this yet">
            queued
          </span>
        )}
        {proposals.map(({ proposal, arrow: proposed }) => (
          <span key={proposal.id} className="mark proposed">
            proposed: {LEVEL_LABEL[proposed.level]}
          </span>
        ))}
      </span>
    </button>
  );
}

export function AccessBoard() {
  const portal = usePortalContext();
  const { map, snapshot, now } = portal;
  const [open, setOpen] = useState<{ readonly from: string; readonly to: string } | null>(() =>
    portal.route.selection._tag === "arrow"
      ? { from: portal.route.selection.from, to: portal.route.selection.to }
      : null,
  );
  const sources: ReadonlyArray<Source> = [
    ...map.machines.map((machine): Source => ({ _tag: "machine", machine })),
    ...map.clients.map((client): Source => ({ _tag: "client", client })),
  ];
  const targets = map.machines;
  if (map.machines.length === 0)
    return (
      <div className="card view empty">
        <h2>No machines yet</h2>
        <p>Add a machine. Its arrows show here as a board.</p>
      </div>
    );
  const toggle = (from: string, to: string) =>
    setOpen((current) => (current?.from === from && current.to === to ? null : { from, to }));
  const columns = `minmax(150px, 1.1fr) repeat(${targets.length}, minmax(118px, 1fr)) minmax(120px, 0.8fr)`;

  return (
    <div className="board-wrap">
      <ProposalStrip proposals={snapshot.proposals} />
      <div className="card view board-card">
        <div className="view-head">
          <h2>Who can use whom</h2>
          <p className="small muted">
            A row uses a column. Tap a chip to change it. Colour is the level; marks say what else
            the arrow gives.
          </p>
        </div>
        <div
          className="board"
          role="table"
          aria-label="Access board"
          style={{ "--cols": columns } as never}
        >
          <div className="board-head" role="row">
            <span className="board-corner" role="columnheader">
              uses →
            </span>
            {targets.map((target) => (
              <span key={target.id} className="board-col" role="columnheader">
                <MachineLink id={target.id}>{target.name}</MachineLink>
              </span>
            ))}
            <span className="board-col" role="columnheader">
              On the map
            </span>
          </div>
          {sources.map((source) => {
            const id = sourceId(source);
            const openHere = open?.from === id ? open : null;
            const presence =
              source._tag === "machine" ? snapshot.presence[source.machine.id] : undefined;
            const state = source._tag === "machine" ? presenceState(presence) : null;
            return (
              <div key={id} className={`board-row${openHere ? " open" : ""}`} role="row">
                <span className="board-source" role="rowheader">
                  {source._tag === "machine" ? (
                    <MachineLink id={source.machine.id}>
                      <span className="icon">
                        <KindIcon kind={source.machine.kind} />
                      </span>
                      <b>{source.machine.name}</b>
                    </MachineLink>
                  ) : (
                    <button
                      type="button"
                      className="link"
                      onClick={() => portal.select({ _tag: "client", id: source.client.id })}
                    >
                      <span className="icon">
                        <ClientIcon />
                      </span>
                      <b>{source.client.name}</b>
                    </button>
                  )}
                  {state && (
                    <span className={`sticker flat ${PRESENCE_STICKER[state]}`}>
                      {state === "offline"
                        ? `offline ${timeAgo(presence?.lastSeenAt ?? null, now)}`
                        : state}
                    </span>
                  )}
                  {source._tag === "client" && <span className="sticker flat">client</span>}
                </span>
                {targets.map((target) =>
                  source._tag === "machine" && source.machine.id === target.id ? (
                    <span
                      key={target.id}
                      className="board-self"
                      role="cell"
                      aria-label="Same machine"
                    />
                  ) : (
                    <span key={target.id} className="board-cell" role="cell">
                      <Chip
                        source={source}
                        to={target}
                        open={openHere?.to === target.id}
                        onOpen={() => toggle(id, target.id)}
                      />
                    </span>
                  ),
                )}
                <span className="board-cell board-role" role="cell">
                  {source._tag === "machine" ? (
                    <select
                      aria-label={`Map role of ${source.machine.name}`}
                      value={source.machine.mapRole}
                      onChange={(e) => {
                        const role = MAP_ROLES.find((r) => r === e.target.value);
                        if (role)
                          portal.submit(`${source.machine.name} map role ${role}`, [
                            { _tag: "putMachine", machine: { ...source.machine, mapRole: role } },
                          ]);
                      }}
                    >
                      {MAP_ROLES.map((role) => (
                        <option
                          key={role}
                          value={role}
                          disabled={
                            portal.pause !== null &&
                            roleRank(role) > roleRank(source.machine.mapRole)
                          }
                        >
                          {role}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="small muted">no agents</span>
                  )}
                </span>
                {openHere && (
                  <BoardEditor source={source} toId={openHere.to} close={() => setOpen(null)} />
                )}
              </div>
            );
          })}
        </div>
        <div className="legend small">
          <span>
            <span className="swatch lvl-read" /> Read only
          </span>
          <span>
            <span className="swatch lvl-standard" /> Standard
          </span>
          <span>
            <span className="swatch lvl-admin" /> Admin
          </span>
          <span>
            <span className="mark">
              <RobotIcon /> tools
            </span>{" "}
            agent tools
          </span>
          <span>
            <span className="mark">exec</span> shell commands
          </span>
          <span>
            <span className="mark temp">
              <ClockIcon label="temporary" /> 59 min
            </span>{" "}
            returns to the earlier level
          </span>
          <span>
            <span className="mark proposed">proposed</span> an agent asks for more
          </span>
        </div>
      </div>
    </div>
  );
}

/** The editor under the row of the open chip. */
function BoardEditor({ source, toId, close }: { source: Source; toId: string; close: () => void }) {
  const portal = usePortalContext();
  const to = portal.map.machines.find((m) => m.id === toId);
  if (!to) return null;
  const name = sourceName(source);
  return (
    <div className="board-editor" role="cell">
      <div className="row">
        <h3 className="grow">
          {name} <span className="verb">uses</span> {to.name}
        </h3>
        {source._tag === "machine" && (
          <button
            type="button"
            className="btn small"
            onClick={() => portal.select({ _tag: "arrow", from: source.machine.id, to: to.id })}
          >
            Full panel
          </button>
        )}
        <button type="button" className="btn small" onClick={close}>
          Close
        </button>
      </div>
      {source._tag === "machine" ? (
        <ArrowEditor from={source.machine} to={to} />
      ) : (
        <ClientArrowEditor client={source.client} to={to} />
      )}
    </div>
  );
}
