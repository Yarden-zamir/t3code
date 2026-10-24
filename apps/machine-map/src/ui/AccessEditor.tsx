/**
 * The arrow controls that the Map, the Board and the arrow panel share: the badges that sum up
 * one arrow, the owner actions on it (raise, lower, remove, temporary, agent tools, exec,
 * proposals), and the full editor. The views differ in where they put these, not in what they do.
 */
import { useState } from "react";
import {
  arrowCapabilities,
  MACHINE_LEVEL_SCOPES,
  type MachineLevel,
} from "@t3tools/contracts/machineMap";

import type { WriteResult } from "../api.ts";
import { arrowChange, clientArrowChange, usesText } from "../rules/access.ts";
import { findArrow, findClientArrow, LEVELS, levelRank, stepLevel } from "../rules/map.ts";
import { callApi } from "./apiClient.ts";
import { CapabilityList } from "./ArrowCapabilities.tsx";
import { usePortalContext, type Portal } from "./context.ts";
import {
  arrowAsks,
  arrowEndRoute,
  arrowEnds,
  arrowEndWait,
  grantCut,
  type ArrowAsk,
  type Grant,
} from "./derive.ts";
import {
  actorText,
  CAPABILITY_LABEL,
  COMMAND_STICKER,
  DURATION_LABEL,
  durationExpiry,
  LEVEL_LABEL,
  LEVEL_TEXT,
  PROPOSAL_REASON,
  shortTime,
  timeAgo,
  timeUntil,
  type Duration,
} from "./format.ts";
import { ClientIcon, KindIcon, PlugIcon, TerminalIcon, TimerIcon } from "./icons.tsx";
import type { Route, Selection } from "./route.ts";
import { ClientLink, MachineLink, RouteLink } from "./StickerLink.tsx";

/** The short level names of small badges. The panel uses `LEVEL_LABEL`. */
export const LEVEL_SHORT: Record<MachineLevel, string> = {
  none: "none",
  read: "read",
  standard: "std",
  admin: "admin",
};

/** MM-711: while paused, only lower access. */
const raiseBlocked = (portal: Portal, from: MachineLevel, to: MachineLevel) =>
  portal.pause !== null && levelRank(to) > levelRank(from);

/** MM-804: approve or reject a proposal. The Inbox does the same through its own buttons. */
export function decideProposal(portal: Portal, id: string, verdict: "approve" | "reject"): void {
  portal.call(
    () =>
      callApi<WriteResult | { rejected: string }>(
        "POST",
        `/api/proposals/${encodeURIComponent(id)}/${verdict}`,
      ),
    verdict === "approve" ? "Approved." : "Rejected.",
  );
}

/** Every owner change of one arrow, as one revision each. */
export function grantActions(portal: Portal, grant: Grant) {
  const { map } = portal;
  const sentence = usesText(grant.from.name, grant.to.name);
  const setLevel = (level: MachineLevel, expiresAt: string | null) => {
    const suffix = expiresAt === null ? "" : ` until ${shortTime(expiresAt)}`;
    const change =
      grant._tag === "machine"
        ? arrowChange(map, { from: grant.from.id, to: grant.to.id, level, expiresAt })
        : clientArrowChange(map, { client: grant.from.id, to: grant.to.id, level, expiresAt });
    void portal.submit(`${sentence}: ${LEVEL_LABEL[level]}${suffix}`, [change]);
  };
  const setAgents = (patch: { agentTools?: boolean; exec?: boolean }, label: string) => {
    if (grant._tag !== "machine") return;
    void portal.submit(`${sentence}: ${label}`, [
      arrowChange(map, {
        from: grant.from.id,
        to: grant.to.id,
        level: grant.arrow.level,
        expiresAt: grant.arrow.expiresAt,
        ...patch,
      }),
    ]);
  };
  return {
    setLevel,
    /** One step, permanent. */
    step: (direction: 1 | -1) => {
      const next = stepLevel(grant.arrow.level, direction);
      if (next) setLevel(next, null);
    },
    /** Level `none` and no agent tools: the arrow leaves the map. */
    remove: () => {
      const change =
        grant._tag === "machine"
          ? arrowChange(map, {
              from: grant.from.id,
              to: grant.to.id,
              level: "none",
              agentTools: false,
              expiresAt: null,
            })
          : clientArrowChange(map, {
              client: grant.from.id,
              to: grant.to.id,
              level: "none",
              expiresAt: null,
            });
      void portal.submit(`${sentence}: removed`, [change]);
    },
    makePermanent: () => setLevel(grant.arrow.level, null),
    /** MM-304: the expiry now, done by the owner. */
    endNow: () => setLevel(grant.arrow.revertLevel ?? grant.arrow.level, null),
    agentTools: (on: boolean) => setAgents({ agentTools: on }, `agent tools ${on ? "on" : "off"}`),
    exec: (on: boolean) => setAgents({ exec: on }, `exec ${on ? "on" : "off"}`),
    canRaise: (to: MachineLevel) => !raiseBlocked(portal, grant.arrow.level, to),
  };
}

/** MM-1915: the badges of one arrow: level, then agent tools, exec and expiry as icons. */
export function GrantBadges({
  grant,
  now,
  short = false,
}: {
  grant: Grant;
  now: number;
  short?: boolean;
}) {
  const { arrow } = grant;
  const machine = grant._tag === "machine" ? grant.arrow : null;
  const can = machine ? arrowCapabilities(machine) : [];
  return (
    <span className="grant-badges">
      <span className={`lvl-pill lvl-${arrow.level}`}>
        {short ? LEVEL_SHORT[arrow.level] : LEVEL_LABEL[arrow.level]}
      </span>
      {machine?.agentTools && (
        <span
          className="glyph"
          data-tip={`Agent tools: ${can.map((c) => CAPABILITY_LABEL[c]).join(", ") || "none at this level"}`}
        >
          <PlugIcon />
        </span>
      )}
      {can.includes("exec") && (
        <span className="glyph" data-tip="Exec: agents run shell commands">
          <TerminalIcon />
        </span>
      )}
      {arrow.expiresAt && arrow.revertLevel && (
        <span
          className="glyph timer"
          data-tip={`Back to ${LEVEL_LABEL[arrow.revertLevel]} ${timeUntil(arrow.expiresAt, now)}`}
        >
          <TimerIcon />
          {timeUntil(arrow.expiresAt, now).replace("in ", "")}
        </span>
      )}
    </span>
  );
}

/** MM-804: one waiting proposal of an arrow, with Approve and Reject in place. */
export function AskCallout({ ask }: { ask: ArrowAsk }) {
  const portal = usePortalContext();
  const reason = PROPOSAL_REASON[ask.proposal.reason];
  const asked = [LEVEL_LABEL[ask.arrow.level]];
  if (ask.arrow.agentTools) asked.push("agent tools");
  if (ask.arrow.exec) asked.push("exec");
  return (
    <div className="callout ask-callout">
      <div className="grow">
        <span className={`sticker flat ${reason.look}`}>{reason.sticker}</span>{" "}
        <b>{actorText(ask.proposal.actor, portal.map)}</b> asks for {asked.join(" + ")}.{" "}
        <span className="muted small">
          Expires {timeUntil(ask.proposal.expiresAt, portal.now)}.
        </span>
      </div>
      {ask.proposal.changes.length > 1 ? (
        // MM-804: Approve decides the whole proposal, so one with more changes opens first.
        <div className="actions">
          <span className="small muted">
            The proposal has {ask.proposal.changes.length} changes.
          </span>
          <button
            type="button"
            className="btn small"
            onClick={() => portal.select({ _tag: "proposal", id: ask.proposal.id }, "inbox")}
          >
            Open the proposal
          </button>
        </div>
      ) : (
        <div className="actions">
          <button
            type="button"
            className="btn small primary"
            onClick={() => decideProposal(portal, ask.proposal.id, "approve")}
          >
            Approve
          </button>
          <button
            type="button"
            className="btn small danger"
            onClick={() => decideProposal(portal, ask.proposal.id, "reject")}
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

/** MM-304: a temporary level, with its two ways out. */
export function ExpiryCallout({ grant }: { grant: Grant }) {
  const portal = usePortalContext();
  const { arrow } = grant;
  if (!arrow.expiresAt || !arrow.revertLevel) return null;
  const actions = grantActions(portal, grant);
  return (
    <div className="callout expiry-callout">
      <div className="grow">
        <TimerIcon /> <b>{LEVEL_LABEL[arrow.level]}</b> until {shortTime(arrow.expiresAt)} (
        {timeUntil(arrow.expiresAt, portal.now)}), then <b>{LEVEL_LABEL[arrow.revertLevel]}</b>.
      </div>
      <div className="actions">
        <button type="button" className="btn small" onClick={actions.makePermanent}>
          Keep {LEVEL_LABEL[arrow.level]}
        </button>
        <button type="button" className="btn small" onClick={actions.endNow}>
          Back to {LEVEL_LABEL[arrow.revertLevel]} now
        </button>
      </div>
    </div>
  );
}

/**
 * The full editor of one arrow. Level first, as a ladder with raise, lower and remove. Agent tools
 * and exec are separate switches, and what agents can then do follows in words.
 */
export function GrantEditor({ grant }: { grant: Grant }) {
  const portal = usePortalContext();
  const { map, snapshot } = portal;
  const [duration, setDuration] = useState<Duration>("permanent");
  const [until, setUntil] = useState("");
  const actions = grantActions(portal, grant);
  const { arrow } = grant;
  const machineArrow = grant._tag === "machine" ? grant.arrow : null;
  const asks =
    grant._tag === "machine" ? arrowAsks(snapshot.proposals, grant.from.id, grant.to.id) : [];
  const was = grantCut(portal.pause, grant);
  const pick = (level: MachineLevel) => {
    // oxlint-disable-next-line react/purity -- This runs in a click handler, not during render.
    const expiry = durationExpiry(duration, until, Date.now());
    if (expiry === undefined) {
      portal.call(() => Promise.reject(new Error("Pick a time in the future.")));
      return;
    }
    actions.setLevel(level, expiry);
  };
  const up = stepLevel(arrow.level, 1);
  const down = stepLevel(arrow.level, -1);
  const reverse = grant._tag === "machine" ? findArrow(map, grant.to.id, grant.from.id) : null;
  const removable = arrow.level !== "none" || (machineArrow !== null && machineArrow.agentTools);

  return (
    <div className="grant-editor">
      <h2 className="grant-title">
        <span className="end">
          {grant._tag === "client" ? (
            <>
              <ClientIcon />
              <ClientLink id={grant.from.id}>{grant.from.name}</ClientLink>
            </>
          ) : (
            <>
              <KindIcon kind={grant.from.kind} />
              <MachineLink id={grant.from.id}>{grant.from.name}</MachineLink>
            </>
          )}
        </span>
        <span className="verb">uses</span>
        <span className="end">
          <KindIcon kind={grant.to.kind} />
          <MachineLink id={grant.to.id}>{grant.to.name}</MachineLink>
        </span>
      </h2>
      <p className="desc">
        What {grant.from.name} can do on {grant.to.name}.
        {reverse && (
          <>
            {" "}
            <RouteLink
              route={{
                view: portal.route.view,
                selection: { _tag: "arrow", from: grant.to.id, to: grant.from.id },
              }}
            >
              Other way: {LEVEL_LABEL[reverse.level]}
            </RouteLink>
          </>
        )}
      </p>

      {asks.map((ask) => (
        <AskCallout key={ask.proposal.id} ask={ask} />
      ))}
      <ExpiryCallout grant={grant} />
      {portal.pause && (
        <div className="paused-note">
          <span className="sticker">paused</span> Access only goes down until you resume.
        </div>
      )}
      {was && (
        <p className="hint">The pause cut this arrow. Resume returns it to {LEVEL_LABEL[was]}.</p>
      )}

      <h3 className="section">Level</h3>
      <div className="ladder" role="group" aria-label="Level">
        {LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            className={`rung lvl-${level}`}
            aria-pressed={arrow.level === level}
            disabled={!actions.canRaise(level)}
            onClick={() => pick(level)}
          >
            {LEVEL_LABEL[level]}
          </button>
        ))}
      </div>
      <p className="desc">{LEVEL_TEXT[arrow.level]}</p>
      {arrow.level !== "none" && (
        <details className="more">
          <summary>{MACHINE_LEVEL_SCOPES[arrow.level].length} T3 scopes</summary>
          <p className="small mono scopes">{MACHINE_LEVEL_SCOPES[arrow.level].join(", ")}</p>
        </details>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn small"
          disabled={down === null}
          onClick={() => down && pick(down)}
        >
          Lower{down ? ` to ${LEVEL_LABEL[down]}` : ""}
        </button>
        <button
          type="button"
          className="btn small"
          disabled={up === null || !actions.canRaise(up)}
          onClick={() => up && pick(up)}
        >
          Raise{up ? ` to ${LEVEL_LABEL[up]}` : ""}
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn small danger"
          disabled={!removable}
          onClick={actions.remove}
        >
          Remove
        </button>
      </div>
      <div className="lasts">
        <span className="small muted">The next change lasts</span>
        <div className="seg tiny" role="group" aria-label="How long">
          {(["permanent", "hour", "day", "until"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={duration === d}
              onClick={() => setDuration(d)}
            >
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
            onChange={(e) => setUntil(e.target.value)}
          />
        )}
      </div>

      {machineArrow && grant._tag === "machine" && (
        <>
          <h3 className="section">Agents</h3>
          <label className="row toggle-row">
            <span>
              <span className="t">
                <PlugIcon /> Agent tools
              </span>
              <span className="v">
                Agents on {grant.from.name} call T3 tools on {grant.to.name}.
              </span>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={machineArrow.agentTools}
              disabled={portal.pause !== null && !machineArrow.agentTools}
              onChange={(e) => actions.agentTools(e.target.checked)}
            />
          </label>
          <label className="row toggle-row">
            <span>
              <span className="t">
                <TerminalIcon /> Exec
              </span>
              <span className="v">
                {machineArrow.agentTools
                  ? levelRank(machineArrow.level) >= levelRank("standard")
                    ? `Shell commands as ${grant.to.name}'s T3 user.`
                    : "Works only at Standard or Admin."
                  : "Needs agent tools."}
              </span>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={machineArrow.exec}
              disabled={!machineArrow.exec && (!machineArrow.agentTools || portal.pause !== null)}
              onChange={(e) => actions.exec(e.target.checked)}
            />
          </label>
          <details className="more">
            <summary>What agents on {grant.from.name} can do</summary>
            <CapabilityList arrow={machineArrow} from={grant.from.name} to={grant.to.name} />
          </details>
          <Delivery grant={grant} />
          <ConnectionTest grant={grant} />
          <p className="desc footnote">
            {grant.from.name} proves who it is with its own Cloudflare service token,{" "}
            <code>{grant.from.tokenClientId}</code>. {grant.to.name} applies a change in under a
            second and ends open sessions from {grant.from.name} when access drops.
          </p>
        </>
      )}
      {grant._tag === "client" && (
        <p className="hint">
          A client never gets agent tools.{" "}
          <RouteLink
            route={{ view: portal.route.view, selection: { _tag: "client", id: grant.from.id } }}
          >
            Open {grant.from.name}
          </RouteLink>
        </p>
      )}
    </div>
  );
}

/** MM-602, MM-604: which end applied the arrow. */
function Delivery({ grant }: { grant: Extract<Grant, { _tag: "machine" }> }) {
  const portal = usePortalContext();
  const ends = arrowEnds(portal.snapshot, grant.from.id, grant.to.id);
  // MM-604: the target first, then the source, for example "applied on VPS, queued for Mac".
  const parts = [[ends.to, grant.to] as const, [ends.from, grant.from] as const].map(
    ([end, machine]): { text: string; route: Route } => {
      const wait = arrowEndWait(end, machine);
      return end === "applied" || wait === null
        ? {
            text: `applied on ${machine.name}`,
            route: { view: portal.route.view, selection: { _tag: "machine", id: machine.id } },
          }
        : { text: wait, route: arrowEndRoute(end, machine.id) };
    },
  );
  const applied = ends.from === "applied" && ends.to === "applied";
  return (
    <p className="small delivery">
      <span className={`sticker flat ${applied ? "ok" : "wait"}`}>
        {applied ? "applied" : "waiting"}
      </span>{" "}
      {parts.map((part, i) => (
        <span key={part.text}>
          {i > 0 && ", "}
          <RouteLink route={part.route}>
            {i === 0 ? part.text.charAt(0).toUpperCase() + part.text.slice(1) : part.text}
          </RouteLink>
        </span>
      ))}
      .
    </p>
  );
}

/** MM-307: the source connects to the target and reports what it got. */
function ConnectionTest({ grant }: { grant: Extract<Grant, { _tag: "machine" }> }) {
  const portal = usePortalContext();
  const { snapshot, now } = portal;
  const lastTest = snapshot.commands.find(
    (c) =>
      c.machineId === grant.from.id && c.input._tag === "testArrow" && c.input.to === grant.to.id,
  );
  return (
    <>
      <div className="actions spaced">
        {/* MM-502: only a machine that reports the command can test. */}
        {snapshot.presence[grant.from.id]?.status?.commands.includes("testArrow") && (
          <button
            type="button"
            className="btn small"
            onClick={() => portal.command(grant.from.id, { _tag: "testArrow", to: grant.to.id })}
          >
            Test the connection
          </button>
        )}
        {lastTest && (
          <span className="small muted">
            Last test{" "}
            <span className={`sticker flat ${COMMAND_STICKER[lastTest.status]}`}>
              {lastTest.status}
            </span>{" "}
            {timeAgo(lastTest.updatedAt, now)}
          </span>
        )}
      </div>
      {lastTest?.result != null && <pre>{JSON.stringify(lastTest.result, null, 2)}</pre>}
      {lastTest?.error && <p className="error-text">{lastTest.error}</p>}
    </>
  );
}

/** The arrow panel, for a machine arrow or a client arrow. */
export function GrantPanel({
  selection,
}: {
  selection: Extract<Selection, { _tag: "arrow" | "clientArrow" }>;
}) {
  const portal = usePortalContext();
  const { map } = portal;
  const to = map.machines.find((m) => m.id === selection.to);
  if (selection._tag === "arrow") {
    const from = map.machines.find((m) => m.id === selection.from);
    if (!from || !to || from.id === to.id) return <GoneNote />;
    return (
      <GrantEditor
        key={`${from.id}>${to.id}`}
        grant={{ _tag: "machine", from, to, arrow: findArrow(map, from.id, to.id) }}
      />
    );
  }
  const client = map.clients.find((c) => c.id === selection.client);
  if (!client || !to) return <GoneNote />;
  return (
    <GrantEditor
      key={`${client.id}>${to.id}`}
      grant={{ _tag: "client", from: client, to, arrow: findClientArrow(map, client.id, to.id) }}
    />
  );
}

const GoneNote = () => (
  <div className="empty compact-empty">
    <h3>This arrow is gone</h3>
    <p>Another page or an agent removed a machine or a client. Close the panel to go on.</p>
  </div>
);
