/**
 * The compact arrow editor of the board and the hub designs. It covers the whole arrow state:
 * level, how long, agent tools, exec, the expiry, the proposals that wait on it, and the pause cut.
 * The rules come from `rules/access.ts`; the facts from `derive.ts`.
 */
import { useState } from "react";
import type {
  ClientRecord,
  MachineLevel,
  MachineRecord,
  MapProposal,
} from "@t3tools/contracts/machineMap";

import type { WriteResult } from "../../api.ts";
import { arrowChange, clientArrowChange, usesText } from "../../rules/access.ts";
import { findArrow, findClientArrow, LEVELS, levelRank } from "../../rules/map.ts";
import { callApi } from "../apiClient.ts";
import { usePortalContext } from "../context.ts";
import { arrowEndWait, arrowEnds, arrowProposals, cutLevel } from "../derive.ts";
import { actorText, LEVEL_LABEL, LEVEL_TEXT, shortTime, timeAgo, timeUntil } from "../format.ts";
import { DURATION_LABEL, durationExpiry, PausedNote, type Duration } from "../panels.tsx";

/** MM-804: approve or reject one proposal where it shows. */
export function ProposalActions({ proposal }: { proposal: MapProposal }) {
  const portal = usePortalContext();
  const run = (verb: "approve" | "reject") =>
    portal.call(
      () =>
        callApi<WriteResult>("POST", `/api/proposals/${encodeURIComponent(proposal.id)}/${verb}`),
      verb === "approve" ? "Approved." : "Rejected.",
    );
  return (
    <span className="actions">
      <button type="button" className="btn small primary" onClick={() => run("approve")}>
        Approve
      </button>
      <button type="button" className="btn small" onClick={() => run("reject")}>
        Reject
      </button>
    </span>
  );
}

/** MM-804: one waiting proposal of an arrow, with who asked and what it would set. */
export function ProposalLine({
  proposal,
  level,
  agentTools,
  exec,
}: {
  proposal: MapProposal;
  level: MachineLevel;
  agentTools?: boolean;
  exec?: boolean;
}) {
  const portal = usePortalContext();
  return (
    <div className="row proposal-line">
      <span className="grow">
        <span className="sticker wait flat">proposed</span>{" "}
        <span className={`sticker lvl-${level} flat`}>{LEVEL_LABEL[level]}</span>
        {agentTools && <span className="sticker accent flat">tools</span>}
        {exec && <span className="sticker accent flat">exec</span>}
        <span className="v">
          {actorText(proposal.actor, portal.map)} · {timeAgo(proposal.at, portal.now)} · expires{" "}
          {timeUntil(proposal.expiresAt, portal.now)}
        </span>
      </span>
      <ProposalActions proposal={proposal} />
    </div>
  );
}

/** MM-304: the duration that the next level change gets. */
export function DurationPicker({
  duration,
  until,
  onDuration,
  onUntil,
}: {
  duration: Duration;
  until: string;
  onDuration: (d: Duration) => void;
  onUntil: (value: string) => void;
}) {
  return (
    <>
      <div className="seg wide" role="group" aria-label="How long">
        {(["permanent", "hour", "day", "until"] as const).map((d) => (
          <button key={d} type="button" aria-pressed={duration === d} onClick={() => onDuration(d)}>
            {DURATION_LABEL[d]}
          </button>
        ))}
      </div>
      {duration === "until" && (
        <input
          type="datetime-local"
          aria-label="Until"
          className="full"
          value={until}
          onChange={(e) => onUntil(e.target.value)}
        />
      )}
    </>
  );
}

/** Keeps a duration choice and turns it into an expiry at the time of the click. */
export function useDuration() {
  const portal = usePortalContext();
  const [duration, setDuration] = useState<Duration>("permanent");
  const [until, setUntil] = useState("");
  const expiry = (): string | null | undefined => {
    const result = durationExpiry(duration, until, Date.now());
    if (result === undefined)
      portal.call(() => Promise.reject(new Error("Pick a time in the future.")));
    return result;
  };
  return { duration, until, setDuration, setUntil, expiry };
}

/** The level buttons. A pause lets nothing rise (MM-711). */
export function LevelSeg({
  level,
  label,
  onLevel,
}: {
  level: MachineLevel;
  label: string;
  onLevel: (level: MachineLevel) => void;
}) {
  const portal = usePortalContext();
  return (
    <div className="seg wide" role="group" aria-label={label}>
      {LEVELS.map((candidate) => (
        <button
          key={candidate}
          type="button"
          aria-pressed={level === candidate}
          disabled={portal.pause !== null && levelRank(candidate) > levelRank(level)}
          onClick={() => onLevel(candidate)}
        >
          {LEVEL_LABEL[candidate]}
        </button>
      ))}
    </div>
  );
}

/** MM-301 to MM-304, MM-1908: the editor of one machine arrow. */
export function ArrowEditor({ from, to }: { from: MachineRecord; to: MachineRecord }) {
  const portal = usePortalContext();
  const { map, snapshot, now } = portal;
  const picker = useDuration();
  const arrow = findArrow(map, from.id, to.id);
  const was = arrow.level === "none" ? cutLevel(portal.pause, from.id, to.id) : null;
  const proposals = arrowProposals(snapshot, from.id, to.id);
  const ends = arrowEnds(snapshot, from.id, to.id);
  const waits = [arrowEndWait(ends.to, to), arrowEndWait(ends.from, from)].filter(
    (wait): wait is string => wait !== null,
  );
  const f = from.name;
  const t = to.name;
  const set = (summary: string, input: Parameters<typeof arrowChange>[1]) =>
    portal.submit(summary, [arrowChange(map, input)]);
  const setLevel = (level: MachineLevel) => {
    const expiresAt = picker.expiry();
    if (expiresAt === undefined) return;
    const suffix = expiresAt === null ? "" : ` until ${shortTime(expiresAt)}`;
    set(`${usesText(f, t)}: ${LEVEL_LABEL[level]}${suffix}`, {
      from: from.id,
      to: to.id,
      level,
      expiresAt,
    });
  };

  return (
    <div className="arrow-editor stack">
      {portal.pause && <PausedNote />}
      {was && (
        <p className="hint">The pause cut this arrow. Resume returns it to {LEVEL_LABEL[was]}.</p>
      )}
      {proposals.map(({ proposal, arrow: proposed }) => (
        <ProposalLine
          key={proposal.id}
          proposal={proposal}
          level={proposed.level}
          agentTools={proposed.agentTools}
          exec={proposed.exec}
        />
      ))}
      <div className="editor-grid">
        <div className="stack tight">
          <span className="t">How long</span>
          <DurationPicker
            duration={picker.duration}
            until={picker.until}
            onDuration={picker.setDuration}
            onUntil={picker.setUntil}
          />
        </div>
        <div className="stack tight">
          <span className="t">Level</span>
          <LevelSeg level={arrow.level} label="Level" onLevel={setLevel} />
          <span className="v">{LEVEL_TEXT[arrow.level]}</span>
        </div>
      </div>
      {arrow.expiresAt && arrow.revertLevel && (
        <div className="row callout">
          <div className="v">
            <span className="sticker warn flat">temp</span> Returns to{" "}
            {LEVEL_LABEL[arrow.revertLevel]} {timeUntil(arrow.expiresAt, now)}.
          </div>
          <button
            type="button"
            className="btn small"
            onClick={() =>
              set(`${usesText(f, t)}: made permanent`, {
                from: from.id,
                to: to.id,
                level: arrow.level,
                expiresAt: null,
              })
            }
          >
            Make permanent
          </button>
        </div>
      )}
      <div className="editor-grid">
        <label className="row toggle-row">
          <span>
            <span className="t">Agent tools</span>
            <span className="v">
              Agents on {f} call T3 tools on {t}, within the level.
            </span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={arrow.agentTools}
            disabled={portal.pause !== null && !arrow.agentTools}
            onChange={(e) =>
              set(`${usesText(f, t)}: agent tools ${e.target.checked ? "on" : "off"}`, {
                from: from.id,
                to: to.id,
                level: arrow.level,
                agentTools: e.target.checked,
                expiresAt: arrow.expiresAt,
              })
            }
          />
        </label>
        <label className="row toggle-row">
          <span>
            <span className="t">Exec</span>
            <span className="v">
              {arrow.agentTools
                ? levelRank(arrow.level) >= levelRank("standard")
                  ? `Agents on ${f} run shell commands on ${t}.`
                  : "Works only at Standard or Admin."
                : "Turn on agent tools first."}
            </span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={arrow.exec}
            disabled={!arrow.exec && (!arrow.agentTools || portal.pause !== null)}
            onChange={(e) =>
              set(`${usesText(f, t)}: exec ${e.target.checked ? "on" : "off"}`, {
                from: from.id,
                to: to.id,
                level: arrow.level,
                exec: e.target.checked,
                expiresAt: arrow.expiresAt,
              })
            }
          />
        </label>
      </div>
      {waits.length > 0 && (
        <p className="small">
          <span className="sticker wait flat">pending</span> {waits.join(", ")}.
        </p>
      )}
    </div>
  );
}

/** MM-309: the editor of one client arrow. A client never gets agent tools. */
export function ClientArrowEditor({ client, to }: { client: ClientRecord; to: MachineRecord }) {
  const portal = usePortalContext();
  const { map, now } = portal;
  const picker = useDuration();
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
    <div className="arrow-editor stack">
      {portal.pause && <PausedNote />}
      {was && (
        <p className="hint">The pause cut this arrow. Resume returns it to {LEVEL_LABEL[was]}.</p>
      )}
      <div className="editor-grid">
        <div className="stack tight">
          <span className="t">How long</span>
          <DurationPicker
            duration={picker.duration}
            until={picker.until}
            onDuration={picker.setDuration}
            onUntil={picker.setUntil}
          />
        </div>
        <div className="stack tight">
          <span className="t">Level</span>
          <LevelSeg
            level={arrow.level}
            label="Level"
            onLevel={(level) => {
              const expiresAt = picker.expiry();
              if (expiresAt !== undefined) setLevel(level, expiresAt);
            }}
          />
          <span className="v">{LEVEL_TEXT[arrow.level]} A client never gets agent tools.</span>
        </div>
      </div>
      {arrow.expiresAt && arrow.revertLevel && (
        <div className="row callout">
          <div className="v">
            <span className="sticker warn flat">temp</span> Returns to{" "}
            {LEVEL_LABEL[arrow.revertLevel]} {timeUntil(arrow.expiresAt, now)}.
          </div>
          <button type="button" className="btn small" onClick={() => setLevel(arrow.level, null)}>
            Make permanent
          </button>
        </div>
      )}
    </div>
  );
}
