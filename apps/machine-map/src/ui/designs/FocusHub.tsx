/**
 * Design "hub": one machine at a time, no graph. The left column lists what the machine can use,
 * the right column who can use it, clients included. Each row has a level stepper and toggles,
 * so a raise, a lower or a removal is one tap. "Changes last" gives every tap its duration.
 */
import { useState } from "react";
import type {
  ClientRecord,
  MachineLevel,
  MachineRecord,
  MachineMapRole,
} from "@t3tools/contracts/machineMap";

import { arrowChange, clientArrowChange, usesText } from "../../rules/access.ts";
import { findArrow, findClientArrow, levelRank, MAP_ROLES, roleRank } from "../../rules/map.ts";
import { usePortalContext } from "../context.ts";
import { arrowEndWait, arrowEnds, arrowProposals, cutLevel, stepLevel } from "../derive.ts";
import {
  LEVEL_LABEL,
  PRESENCE_STICKER,
  presenceState,
  presenceText,
  ROLE_TEXT,
  shortTime,
  timeUntil,
} from "../format.ts";
import { ClientIcon, ClockIcon, KindIcon, RobotIcon } from "../icons.tsx";
import { BuildLabel } from "../BuildLabel.tsx";
import { MachineStickers } from "../MachineStickers.tsx";
import { DurationPicker, ProposalLine, useDuration } from "./ArrowControls.tsx";

type Focus =
  | { readonly _tag: "machine"; readonly machine: MachineRecord }
  | { readonly _tag: "client"; readonly client: ClientRecord };

/** The level stepper: lower on the left, the level in the middle, raise on the right. */
function Stepper({
  level,
  label,
  onLevel,
}: {
  level: MachineLevel;
  label: string;
  onLevel: (level: MachineLevel) => void;
}) {
  const portal = usePortalContext();
  const lower = stepLevel(level, -1);
  const raise = stepLevel(level, 1);
  return (
    <span className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="btn small"
        aria-label={lower ? `Lower to ${LEVEL_LABEL[lower]}` : "Already none"}
        disabled={lower === null}
        onClick={() => lower && onLevel(lower)}
      >
        −
      </button>
      <span className={`sticker lvl-${level} flat`}>{LEVEL_LABEL[level]}</span>
      <button
        type="button"
        className="btn small"
        aria-label={raise ? `Raise to ${LEVEL_LABEL[raise]}` : "Already admin"}
        disabled={raise === null || portal.pause !== null}
        onClick={() => raise && onLevel(raise)}
      >
        +
      </button>
    </span>
  );
}

/** One machine arrow as a row: who, the stepper, the toggles and the states. */
function MachineRow({
  from,
  to,
  side,
  expiry,
}: {
  from: MachineRecord;
  to: MachineRecord;
  /** Which end is the focus: the row names the other end. */
  side: "out" | "in";
  expiry: () => string | null | undefined;
}) {
  const portal = usePortalContext();
  const { map, snapshot, now } = portal;
  const arrow = findArrow(map, from.id, to.id);
  const other = side === "out" ? to : from;
  const was = arrow.level === "none" ? cutLevel(portal.pause, from.id, to.id) : null;
  const proposals = arrowProposals(snapshot, from.id, to.id);
  const ends = arrowEnds(snapshot, from.id, to.id);
  const waits = [arrowEndWait(ends.to, to), arrowEndWait(ends.from, from)].filter(
    (wait): wait is string => wait !== null,
  );
  const set = (summary: string, input: Omit<Parameters<typeof arrowChange>[1], "from" | "to">) =>
    portal.submit(summary, [arrowChange(map, { from: from.id, to: to.id, ...input })]);
  const setLevel = (level: MachineLevel) => {
    const expiresAt = expiry();
    if (expiresAt === undefined) return;
    const suffix = expiresAt === null ? "" : ` until ${shortTime(expiresAt)}`;
    set(`${usesText(from.name, to.name)}: ${LEVEL_LABEL[level]}${suffix}`, { level, expiresAt });
  };
  const toolsOff = !arrow.agentTools;
  const execAllowed = arrow.agentTools && levelRank(arrow.level) >= levelRank("standard");
  return (
    <div className={`hub-row${was ? " cut" : ""}`}>
      <div className="hub-who">
        <button
          type="button"
          className="link"
          onClick={() => portal.select({ _tag: "arrow", from: from.id, to: to.id })}
          data-tip="Open the full arrow panel"
        >
          <span className="icon">
            <KindIcon kind={other.kind} />
          </span>
          <b>{other.name}</b>
        </button>
        <span className="small muted">{usesText(from.name, to.name)}</span>
      </div>
      <Stepper level={arrow.level} label={usesText(from.name, to.name)} onLevel={setLevel} />
      <div className="hub-marks">
        {was && <span className="sticker cut-sticker flat">cut, was {LEVEL_LABEL[was]}</span>}
        <button
          type="button"
          className={`mark toggle${arrow.agentTools ? " on" : ""}`}
          aria-pressed={arrow.agentTools}
          disabled={arrow.level === "none" || (portal.pause !== null && toolsOff)}
          data-tip={
            arrow.agentTools
              ? `Agents on ${from.name} call T3 tools on ${to.name}. Tap to turn off.`
              : `Tap to let agents on ${from.name} call T3 tools on ${to.name}.`
          }
          onClick={() =>
            set(`${usesText(from.name, to.name)}: agent tools ${toolsOff ? "on" : "off"}`, {
              level: arrow.level,
              agentTools: toolsOff,
              expiresAt: arrow.expiresAt,
            })
          }
        >
          <RobotIcon /> tools
        </button>
        <button
          type="button"
          className={`mark toggle${arrow.exec ? " on" : ""}`}
          aria-pressed={arrow.exec}
          disabled={!arrow.exec && (!execAllowed || portal.pause !== null)}
          data-tip={
            arrow.exec
              ? `Agents on ${from.name} run shell commands on ${to.name}. Tap to turn off.`
              : execAllowed
                ? `Tap to let agents on ${from.name} run shell commands on ${to.name}.`
                : "Exec needs agent tools and Standard or Admin."
          }
          onClick={() =>
            set(`${usesText(from.name, to.name)}: exec ${arrow.exec ? "off" : "on"}`, {
              level: arrow.level,
              exec: !arrow.exec,
              expiresAt: arrow.expiresAt,
            })
          }
        >
          exec
        </button>
        {arrow.expiresAt && arrow.revertLevel && (
          <span className="mark temp">
            <ClockIcon label="temporary" /> {LEVEL_LABEL[arrow.revertLevel]} in{" "}
            {timeUntil(arrow.expiresAt, now).replace(/^in /, "")}
            <button
              type="button"
              className="link"
              onClick={() =>
                set(`${usesText(from.name, to.name)}: made permanent`, {
                  level: arrow.level,
                  expiresAt: null,
                })
              }
            >
              keep
            </button>
          </span>
        )}
        {waits.length > 0 && (
          <span className="mark wait" data-tip={waits.join(", ")}>
            queued
          </span>
        )}
      </div>
      {proposals.map(({ proposal, arrow: proposed }) => (
        <ProposalLine
          key={proposal.id}
          proposal={proposal}
          level={proposed.level}
          agentTools={proposed.agentTools}
          exec={proposed.exec}
        />
      ))}
    </div>
  );
}

/** MM-309: one client arrow as a row. Only a level and a duration. */
function ClientRow({
  client,
  to,
  side,
  expiry,
}: {
  client: ClientRecord;
  to: MachineRecord;
  side: "out" | "in";
  expiry: () => string | null | undefined;
}) {
  const portal = usePortalContext();
  const { map, now } = portal;
  const arrow = findClientArrow(map, client.id, to.id);
  const was =
    arrow.level === "none"
      ? (portal.pause?.cutClients.find((c) => c.client === client.id && c.to === to.id)?.level ??
        null)
      : null;
  const setLevel = (level: MachineLevel, expiresAt: string | null) => {
    const suffix = expiresAt === null ? "" : ` until ${shortTime(expiresAt)}`;
    portal.submit(`${usesText(client.name, to.name)}: ${LEVEL_LABEL[level]}${suffix}`, [
      clientArrowChange(map, { client: client.id, to: to.id, level, expiresAt }),
    ]);
  };
  return (
    <div className={`hub-row${was ? " cut" : ""}`}>
      <div className="hub-who">
        <button
          type="button"
          className="link"
          onClick={() =>
            side === "in"
              ? portal.select({ _tag: "client", id: client.id })
              : portal.select({ _tag: "machine", id: to.id })
          }
        >
          <span className="icon">
            {side === "in" ? <ClientIcon /> : <KindIcon kind={to.kind} />}
          </span>
          <b>{side === "in" ? client.name : to.name}</b>
        </button>
        <span className="small muted">{usesText(client.name, to.name)} · client</span>
      </div>
      <Stepper
        level={arrow.level}
        label={usesText(client.name, to.name)}
        onLevel={(level) => {
          const expiresAt = expiry();
          if (expiresAt !== undefined) setLevel(level, expiresAt);
        }}
      />
      <div className="hub-marks">
        {was && <span className="sticker cut-sticker flat">cut, was {LEVEL_LABEL[was]}</span>}
        {arrow.expiresAt && arrow.revertLevel && (
          <span className="mark temp">
            <ClockIcon label="temporary" /> {LEVEL_LABEL[arrow.revertLevel]} in{" "}
            {timeUntil(arrow.expiresAt, now).replace(/^in /, "")}
            <button type="button" className="link" onClick={() => setLevel(arrow.level, null)}>
              keep
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

function FocusHead({ focus }: { focus: Focus }) {
  const portal = usePortalContext();
  const { snapshot, now } = portal;
  if (focus._tag === "client") {
    const { client } = focus;
    return (
      <div className="card hub-head">
        <div className="name">
          <span className="icon">
            <ClientIcon />
          </span>
          <span className="label">
            {client.name}
            <span className="sub">
              {client.serviceToken ? "App client" : "Browser client"} ·{" "}
              {client.keys.length === 1 ? "1 browser key" : `${client.keys.length} browser keys`}
            </span>
          </span>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn small"
            onClick={() => portal.select({ _tag: "client", id: client.id })}
          >
            Client panel
          </button>
        </div>
      </div>
    );
  }
  const { machine } = focus;
  const presence = snapshot.presence[machine.id];
  const state = presenceState(presence);
  const setRole = (role: MachineMapRole) =>
    portal.submit(`${machine.name} map role ${role}`, [
      { _tag: "putMachine", machine: { ...machine, mapRole: role } },
    ]);
  return (
    <div className="card hub-head">
      <div className="name">
        <span className="icon">
          <KindIcon kind={machine.kind} />
        </span>
        <span className="label">
          {machine.name}
          <span className="sub">
            <span className={`sticker flat ${PRESENCE_STICKER[state]}`}>{state}</span>{" "}
            {presenceText(presence, now)}
            {presence?.status && (
              <>
                {" · "}
                <BuildLabel status={presence.status} />
              </>
            )}
          </span>
        </span>
      </div>
      <div className="tags">
        <MachineStickers machine={machine} />
      </div>
      <div className="hub-role">
        <span className="t">Agents on the map</span>
        <div className="seg" role="group" aria-label="Map role">
          {MAP_ROLES.map((role) => (
            <button
              key={role}
              type="button"
              aria-pressed={machine.mapRole === role}
              disabled={portal.pause !== null && roleRank(role) > roleRank(machine.mapRole)}
              onClick={() => setRole(role)}
            >
              {role}
            </button>
          ))}
        </div>
        <span className="v">{ROLE_TEXT[machine.mapRole]}</span>
      </div>
      <div className="actions">
        {machine.hostname && (
          <a
            className="btn small"
            href={`https://${machine.hostname}`}
            target="_blank"
            rel="noreferrer"
          >
            Open T3
          </a>
        )}
        <button
          type="button"
          className="btn small"
          onClick={() => portal.select({ _tag: "machine", id: machine.id })}
        >
          Machine panel
        </button>
      </div>
    </div>
  );
}

export function FocusHub() {
  const portal = usePortalContext();
  const { map, snapshot } = portal;
  const picker = useDuration();
  const [focusId, setFocusId] = useState<string | null>(() =>
    portal.route.selection._tag === "machine" || portal.route.selection._tag === "client"
      ? portal.route.selection.id
      : null,
  );
  const items: ReadonlyArray<Focus> = [
    ...map.machines.map((machine): Focus => ({ _tag: "machine", machine })),
    ...map.clients.map((client): Focus => ({ _tag: "client", client })),
  ];
  if (items.length === 0)
    return (
      <div className="card view empty">
        <h2>No machines yet</h2>
        <p>Add a machine. It shows here with its arrows.</p>
      </div>
    );
  const focus =
    items.find(
      (item) => (item._tag === "machine" ? item.machine.id : item.client.id) === focusId,
    ) ??
    items.find((item) => item._tag === "machine" && snapshot.presence[item.machine.id]?.online) ??
    items[0];
  if (!focus) return null;
  const others = map.machines.filter((m) => focus._tag !== "machine" || m.id !== focus.machine.id);

  return (
    <div className="hub">
      <div className="hub-strip seg" role="tablist" aria-label="Machine">
        {items.map((item) => {
          const id = item._tag === "machine" ? item.machine.id : item.client.id;
          const on = item === focus;
          const state = item._tag === "machine" ? presenceState(snapshot.presence[id]) : "client";
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setFocusId(id)}
            >
              <span className={`dot ${state}`} aria-hidden />
              {item._tag === "machine" ? item.machine.name : item.client.name}
            </button>
          );
        })}
      </div>
      <FocusHead focus={focus} />
      <div className="card hub-duration row">
        <span className="t">Changes last</span>
        <DurationPicker
          duration={picker.duration}
          until={picker.until}
          onDuration={picker.setDuration}
          onUntil={picker.setUntil}
        />
        <span className="v grow">
          {picker.duration === "permanent"
            ? "A tap on − or + sets the level for good."
            : "A tap on − or + sets the level for that time, then it returns."}
        </span>
      </div>
      <div className="hub-cols">
        <section className="card hub-col">
          <h3 className="section">
            {focus._tag === "machine" ? focus.machine.name : focus.client.name} can use
          </h3>
          {others.length === 0 && <p className="hint">No other machine yet.</p>}
          {others.map((to) =>
            focus._tag === "machine" ? (
              <MachineRow
                key={to.id}
                from={focus.machine}
                to={to}
                side="out"
                expiry={picker.expiry}
              />
            ) : (
              <ClientRow
                key={to.id}
                client={focus.client}
                to={to}
                side="out"
                expiry={picker.expiry}
              />
            ),
          )}
        </section>
        <section className="card hub-col">
          <h3 className="section">
            Who can use {focus._tag === "machine" ? focus.machine.name : focus.client.name}
          </h3>
          {focus._tag === "client" ? (
            <p className="hint">Nobody. A machine never uses a client.</p>
          ) : (
            <>
              {others.map((from) => (
                <MachineRow
                  key={from.id}
                  from={from}
                  to={focus.machine}
                  side="in"
                  expiry={picker.expiry}
                />
              ))}
              {map.clients.map((client) => (
                <ClientRow
                  key={client.id}
                  client={client}
                  to={focus.machine}
                  side="in"
                  expiry={picker.expiry}
                />
              ))}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
