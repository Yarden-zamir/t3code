/**
 * Focus design: one machine at a time, as sentences. "Mac uses" lists what the machine can do on
 * each other machine; "Uses Mac" lists who can do what on it, clients included. Above it, one
 * agenda lists what needs the owner or changes on its own: proposals, expiries and waits.
 * Everything is a list, so the phone shows the same thing as the desktop.
 */
import { useState } from "react";
import type { MachineLevel, MachineMapRole } from "@t3tools/contracts/machineMap";

import { findArrow, findClientArrow, LEVELS, MAP_ROLES, roleRank } from "../rules/map.ts";
import {
  AskCallout,
  decideProposal,
  GrantBadges,
  grantActions,
  LEVEL_SHORT,
} from "./AccessEditor.tsx";
import { usePortalContext } from "./context.ts";
import {
  accessAgenda,
  arrowAsks,
  arrowEnds,
  cutLevel,
  grantSelection,
  type AgendaItem,
  type Grant,
} from "./derive.ts";
import {
  LEVEL_LABEL,
  PRESENCE_STICKER,
  presenceState,
  presenceText,
  ROLE_TEXT,
  timeUntil,
} from "./format.ts";
import { ClientIcon, ClockIcon, KindIcon, PlugIcon, TerminalIcon, TimerIcon } from "./icons.tsx";
import { sameSelection } from "./route.ts";

export function FocusView() {
  const portal = usePortalContext();
  const { map, snapshot } = portal;
  const [picked, setPicked] = useState<string | null>(null);
  const machine = map.machines.find((m) => m.id === picked) ?? map.machines[0];
  if (!machine)
    return (
      <div className="card view empty">
        <h2>No machines yet</h2>
        <p>Add the first machine. Its arrows show here.</p>
      </div>
    );

  const others = map.machines.filter((m) => m.id !== machine.id);
  const outgoing = others.map((to): Grant => ({
    _tag: "machine",
    from: machine,
    to,
    arrow: findArrow(map, machine.id, to.id),
  }));
  const incoming = [
    ...others.map((from): Grant => ({
      _tag: "machine",
      from,
      to: machine,
      arrow: findArrow(map, from.id, machine.id),
    })),
    ...map.clients.map((from): Grant => ({
      _tag: "client",
      from,
      to: machine,
      arrow: findClientArrow(map, from.id, machine.id),
    })),
  ];
  const presence = snapshot.presence[machine.id];
  const state = presenceState(presence);
  const setRole = (role: MachineMapRole) =>
    void portal.submit(`${machine.name} map role ${role}`, [
      { _tag: "putMachine", machine: { ...machine, mapRole: role } },
    ]);

  return (
    <div className="focus-view">
      <Agenda />
      <nav className="focus-picker" aria-label="Machine">
        {map.machines.map((m) => {
          const s = presenceState(snapshot.presence[m.id]);
          return (
            <button
              key={m.id}
              type="button"
              className="pick"
              aria-pressed={m.id === machine.id}
              onClick={() => setPicked(m.id)}
            >
              <span className={`dot ${PRESENCE_STICKER[s]}`} aria-label={s} />
              <KindIcon kind={m.kind} />
              {m.name}
            </button>
          );
        })}
      </nav>
      <section className="card focus-card">
        <header className="focus-head">
          <h2>
            <KindIcon kind={machine.kind} /> {machine.name}
          </h2>
          <span className={`sticker ${PRESENCE_STICKER[state]}`}>{state}</span>
          <span className="small muted">{presenceText(presence, portal.now)}</span>
          <button
            type="button"
            className="btn small"
            onClick={() => portal.select({ _tag: "machine", id: machine.id })}
          >
            Machine details
          </button>
        </header>
        <div className="role-line">
          <span className="small">Agents on {machine.name} and the map:</span>
          <div className="seg tiny" role="group" aria-label="Map role">
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
          <span className="small muted">{ROLE_TEXT[machine.mapRole]}</span>
        </div>
        <div className="focus-columns">
          <section>
            <h3 className="section">{machine.name} uses</h3>
            {outgoing.map((grant) => (
              <GrantRow key={grant.to.id} grant={grant} side="to" />
            ))}
          </section>
          <section>
            <h3 className="section">Uses {machine.name}</h3>
            {incoming.map((grant) => (
              <GrantRow key={`${grant._tag}:${grant.from.id}`} grant={grant} side="from" />
            ))}
          </section>
        </div>
      </section>
    </div>
  );
}

/** One arrow as one line: the other end, a level switch, and agent tools and exec in place. */
function GrantRow({ grant, side }: { grant: Grant; side: "from" | "to" }) {
  const name = side === "to" ? grant.to.name : grant.from.name;
  const portal = usePortalContext();
  const actions = grantActions(portal, grant);
  const { arrow } = grant;
  const machineArrow = grant._tag === "machine" ? grant.arrow : null;
  const asks =
    grant._tag === "machine"
      ? arrowAsks(portal.snapshot.proposals, grant.from.id, grant.to.id)
      : [];
  const cut =
    grant._tag === "machine" && arrow.level === "none"
      ? cutLevel(portal.pause, grant.from.id, grant.to.id)
      : null;
  const ends =
    grant._tag === "machine" ? arrowEnds(portal.snapshot, grant.from.id, grant.to.id) : null;
  const waiting = ends !== null && (ends.from !== "applied" || ends.to !== "applied");
  const target = grantSelection(grant);
  const on = sameSelection(portal.route.selection, target);
  const level = (next: MachineLevel) =>
    next === "none" ? actions.remove() : actions.setLevel(next, null);
  return (
    <div className={`grant-row${arrow.level === "none" ? " off" : ""}${on ? " on" : ""}`}>
      <button type="button" className="who" onClick={() => portal.select(target)}>
        {side === "to" ? (
          <KindIcon kind={grant.to.kind} />
        ) : grant._tag === "client" ? (
          <ClientIcon />
        ) : (
          <KindIcon kind={grant.from.kind} />
        )}
        <span className="nm">{name}</span>
        {arrow.expiresAt && arrow.revertLevel && (
          <span className="glyph timer" data-tip={`Back to ${LEVEL_LABEL[arrow.revertLevel]}`}>
            <TimerIcon />
            {timeUntil(arrow.expiresAt, portal.now).replace("in ", "")}
          </span>
        )}
        {cut && <span className="cut-word">cut, was {LEVEL_SHORT[cut]}</span>}
        {waiting && <ClockIcon label="Waits for a machine to apply it" />}
      </button>
      <div className="seg tiny levels" role="group" aria-label={`Level of ${name}`}>
        {LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            className={arrow.level === l ? `lvl-${l}` : undefined}
            aria-pressed={arrow.level === l}
            disabled={!actions.canRaise(l)}
            onClick={() => level(l)}
          >
            {LEVEL_SHORT[l]}
          </button>
        ))}
      </div>
      {machineArrow ? (
        <div className="toggles">
          <button
            type="button"
            className="toggle"
            aria-pressed={machineArrow.agentTools}
            disabled={portal.pause !== null && !machineArrow.agentTools}
            data-tip={machineArrow.agentTools ? "Agent tools on" : "Agent tools off"}
            onClick={() => actions.agentTools(!machineArrow.agentTools)}
          >
            <PlugIcon />
          </button>
          <button
            type="button"
            className="toggle"
            aria-pressed={machineArrow.exec}
            disabled={!machineArrow.exec && (!machineArrow.agentTools || portal.pause !== null)}
            data-tip={
              machineArrow.agentTools
                ? machineArrow.exec
                  ? "Exec on"
                  : "Exec off"
                : "Exec needs agent tools"
            }
            onClick={() => actions.exec(!machineArrow.exec)}
          >
            <TerminalIcon />
          </button>
        </div>
      ) : (
        <div className="toggles muted small">client</div>
      )}
      {asks.map((ask) => (
        <div key={ask.proposal.id} className="row-ask">
          <AskCallout ask={ask} />
        </div>
      ))}
    </div>
  );
}

/** MM-304, MM-602, MM-804: one list of what needs the owner or happens on its own. */
function Agenda() {
  const portal = usePortalContext();
  const items = accessAgenda(portal.snapshot, portal.map);
  if (items.length === 0)
    return (
      <div className="card agenda calm">
        <span className="sticker ok flat">calm</span> No proposals, no time limits, nothing waits.
      </div>
    );
  return (
    <section className="card agenda" aria-label="What changes next">
      <h3 className="section">Next on the arrows</h3>
      <ol>
        {items.map((item) => (
          <AgendaRow key={agendaKey(item)} item={item} />
        ))}
      </ol>
    </section>
  );
}

const agendaKey = (item: AgendaItem) =>
  item._tag === "ask"
    ? `ask:${item.ask.proposal.id}:${item.ask.arrow.from}>${item.ask.arrow.to}`
    : `${item._tag}:${item.grant._tag}:${item.grant.from.id}>${item.grant.to.id}`;

function AgendaRow({ item }: { item: AgendaItem }) {
  const portal = usePortalContext();
  const name = (id: string) => portal.map.machines.find((m) => m.id === id)?.name ?? id;
  switch (item._tag) {
    case "ask": {
      const { arrow, proposal } = item.ask;
      return (
        <li className="agenda-row">
          <span className="when">{timeUntil(item.at, portal.now)}</span>
          <span className="sticker wait flat">asks</span>
          <button
            type="button"
            className="link grow left"
            onClick={() => portal.select({ _tag: "arrow", from: arrow.from, to: arrow.to })}
          >
            {name(arrow.from)} wants {LEVEL_LABEL[arrow.level]} on {name(arrow.to)}
            {arrow.agentTools && " with agent tools"}
            {arrow.exec && " and exec"}
          </button>
          <button
            type="button"
            className="btn small primary"
            onClick={() => decideProposal(portal, proposal.id, "approve")}
          >
            Approve
          </button>
          <button
            type="button"
            className="btn small danger"
            onClick={() => decideProposal(portal, proposal.id, "reject")}
          >
            Reject
          </button>
        </li>
      );
    }
    case "expiry": {
      const actions = grantActions(portal, item.grant);
      const { arrow } = item.grant;
      return (
        <li className="agenda-row">
          <span className="when">{timeUntil(item.at, portal.now)}</span>
          <span className="sticker warn flat">
            <TimerIcon /> ends
          </span>
          <button
            type="button"
            className="link grow left"
            onClick={() => portal.select(grantSelection(item.grant))}
          >
            {item.grant.from.name} uses {item.grant.to.name}:{" "}
            <GrantBadges grant={item.grant} now={portal.now} short /> back to{" "}
            {LEVEL_LABEL[arrow.revertLevel ?? "none"]}
          </button>
          <button type="button" className="btn small" onClick={actions.makePermanent}>
            Keep
          </button>
          <button type="button" className="btn small" onClick={actions.endNow}>
            End now
          </button>
        </li>
      );
    }
    case "queued":
      return (
        <li className="agenda-row">
          <span className="when">waits</span>
          <span className="sticker flat">
            <ClockIcon label="queued" /> queued
          </span>
          <button
            type="button"
            className="link grow left"
            onClick={() => portal.select(grantSelection(item.grant))}
          >
            {item.grant.from.name} uses {item.grant.to.name}: applies when{" "}
            {item.waits.map((m) => m.name).join(" and ")} connects
          </button>
        </li>
      );
  }
}
