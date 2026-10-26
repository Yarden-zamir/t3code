/**
 * MM-1210: the Guests view. Who may open guest links, guest links per machine, and the Cloudflare
 * setup of each machine host, with "Apply" that makes and repairs it.
 */
import { useEffect, useState } from "react";

import type {
  GuestCloudflareStep,
  GuestLinksStatus,
  GuestMachineStatus,
  GuestPartState,
  GuestRules,
} from "../api.ts";
import { callApi } from "./apiClient.ts";
import { External, PermissionLine, ZERO_TRUST_DASHBOARD } from "./Approvals.tsx";
import { usePortalContext } from "./context.ts";
import { machineName } from "./format.ts";
import { MachineLink } from "./StickerLink.tsx";

const CLOUDFLARE_DASHBOARD = "https://dash.cloudflare.com/";
const ONE_TIME_PIN_DOCS =
  "https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/";
const RATE_LIMIT_DOCS =
  "https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/";
const ACTION = "Apply";

const RULE_FIELDS: ReadonlyArray<{
  readonly key: keyof GuestRules;
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
}> = [
  {
    key: "emailDomains",
    label: "Email domains",
    hint: "A guest with an email at one of these domains gets in.",
    placeholder: "example.com",
  },
  {
    key: "emails",
    label: "Emails",
    hint: "These people get in. The owner emails always get in.",
    placeholder: "friend@example.com",
  },
  {
    key: "ipRanges",
    label: "IP ranges",
    hint: "A guest from one of these networks gets in.",
    placeholder: "10.0.0.0/8",
  },
  {
    key: "requireIpRanges",
    label: "Required IP ranges",
    hint: "When set, every guest must also come from one of these networks.",
    placeholder: "10.0.0.0/8",
  },
];

type RulesDraft = Record<keyof GuestRules, string>;

const toDraft = (rules: GuestRules): RulesDraft => ({
  emails: rules.emails.join("\n"),
  emailDomains: rules.emailDomains.join("\n"),
  ipRanges: rules.ipRanges.join("\n"),
  requireIpRanges: rules.requireIpRanges.join("\n"),
});

const lines = (text: string): Array<string> =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const fromDraft = (draft: RulesDraft): GuestRules => ({
  emails: lines(draft.emails),
  emailDomains: lines(draft.emailDomains),
  ipRanges: lines(draft.ipRanges),
  requireIpRanges: lines(draft.requireIpRanges),
});

const errorText = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);

const checkCommand = (hostname: string) =>
  `node scripts/fork-guest-access-check.ts https://${hostname}`;

/** MM-1209: the Cloudflare steps that "Apply" cannot do with the API token. */
function GuestStepGuide({ step }: { step: GuestCloudflareStep }) {
  if (step === "oneTimePin") {
    return (
      <div className="v">
        <strong>Add the One-time PIN login in Cloudflare</strong>
        <ol className="small steps">
          <li>
            Open the <External href={ZERO_TRUST_DASHBOARD}>Zero Trust dashboard</External> and
            choose this account.
          </li>
          <li>Go to Integrations &gt; Identity providers.</li>
          <li>If One-time PIN is not in the list, select Add new, then One-time PIN.</li>
          <li>Come back and select Apply.</li>
        </ol>
        <p className="hint">
          Guests log in with a code that Cloudflare sends to their email.{" "}
          <External href={ONE_TIME_PIN_DOCS}>Cloudflare docs: One-time PIN</External>
        </p>
        <PermissionLine step="oneTimePin" action={ACTION} />
      </div>
    );
  }
  return (
    <div className="v">
      <strong>Add the rate limit rule in Cloudflare</strong>
      <ol className="small steps">
        <li>
          Open the <External href={CLOUDFLARE_DASHBOARD}>Cloudflare dashboard</External> and choose
          the zone of the machine hosts.
        </li>
        <li>Go to Security &gt; WAF &gt; Rate limiting rules, and select Create rule.</li>
        <li>Set the name "T3 guest routes".</li>
        <li>
          Select Edit expression and enter{" "}
          <code>starts_with(http.request.uri.path, "/api/guest/")</code>.
        </li>
        <li>Count by IP. Set 100 requests per 10 seconds, the action Block for 10 seconds.</li>
        <li>Save the rule.</li>
      </ol>
      <p className="hint">
        Without the permission, the portal cannot read the rule, so this step stays here.{" "}
        <External href={RATE_LIMIT_DOCS}>Cloudflare docs: create a rate limiting rule</External>
      </p>
      <PermissionLine step="rateLimit" action={ACTION} />
    </div>
  );
}

function StateSticker({ state }: { state: GuestPartState }) {
  switch (state._tag) {
    case "off":
      return <span className="sticker none">off</span>;
    case "ready":
      return <span className="sticker ok">ready</span>;
    case "needsApply":
      return <span className="sticker wait">needs Apply</span>;
    case "cloudflareStep":
      return <span className="sticker warn">Cloudflare step</span>;
    case "blocked":
      return <span className="sticker warn">blocked</span>;
    case "noHostname":
      return <span className="sticker none">no hostname</span>;
  }
}

function StateText({ state }: { state: GuestPartState }) {
  switch (state._tag) {
    case "needsApply":
    case "blocked":
      return <span className="sub">{state.reason}</span>;
    case "noHostname":
      return (
        <span className="sub">The machine reported no tunnel host yet. Guest links need it.</span>
      );
    default:
      return null;
  }
}

function MachineRow({
  machine,
  busy,
  toggle,
}: {
  machine: GuestMachineStatus;
  busy: boolean;
  toggle: (enabled: boolean) => void;
}) {
  const portal = usePortalContext();
  const name = machineName(portal.map, machine.machineId);
  return (
    <li className="item static">
      <span className="grow">
        <b>
          <MachineLink id={machine.machineId}>{name}</MachineLink>
        </b>
        <span className="sub mono">{machine.hostname ?? "no hostname"}</span>
        <StateText state={machine.state} />
        {machine.state._tag === "ready" && machine.hostname !== null && (
          <span className="sub">
            Check: <code>{checkCommand(machine.hostname)}</code>{" "}
            <button
              type="button"
              className="btn small"
              onClick={() => {
                if (machine.hostname !== null)
                  void navigator.clipboard.writeText(checkCommand(machine.hostname));
              }}
            >
              Copy
            </button>
          </span>
        )}
      </span>
      <StateSticker state={machine.state} />
      <input
        type="checkbox"
        className="switch"
        aria-label={`Guest links on ${name}`}
        checked={machine.enabled}
        disabled={busy}
        onChange={(e) => toggle(e.target.checked)}
      />
    </li>
  );
}

function PartRow({ label, hint, state }: { label: string; hint: string; state: GuestPartState }) {
  return (
    <li className="item static">
      <span className="grow">
        <b>{label}</b>
        <span className="sub">{hint}</span>
        <StateText state={state} />
      </span>
      <StateSticker state={state} />
    </li>
  );
}

export function GuestsView() {
  const [status, setStatus] = useState<GuestLinksStatus | null>(null);
  const [draft, setDraft] = useState<RulesDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const run = (work: () => Promise<GuestLinksStatus>) => {
    setBusy(true);
    work()
      .then((next) => {
        setStatus(next);
        setDraft(toDraft(next.rules));
        setError(null);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    let current = true;
    callApi<GuestLinksStatus>("GET", "/api/guests")
      .then((next) => {
        if (!current) return;
        setStatus(next);
        setDraft(toDraft(next.rules));
      })
      .catch((reason: unknown) => current && setError(errorText(reason)))
      .finally(() => current && setBusy(false));
    return () => {
      current = false;
    };
  }, []);

  const steps = status
    ? [status.oneTimePin, status.rateLimit].flatMap((part) =>
        part._tag === "cloudflareStep" ? [part.step] : [],
      )
    : [];
  const changed =
    status !== null &&
    draft !== null &&
    JSON.stringify(fromDraft(draft)) !== JSON.stringify(status.rules);
  const ownerOnly =
    status !== null && Object.values(status.rules).every((values) => values.length === 0);

  return (
    <div className="card view stack">
      <div className="view-head">
        <div>
          <h2>Guest links</h2>
          <p className="small muted">
            A guest link shows one thread, read only, to a person without a T3 login. Cloudflare
            Access asks the guest for a one-time PIN and lets in only the people of these rules.
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => run(() => callApi<GuestLinksStatus>("GET", "/api/guests"))}
          >
            {busy ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || status?.problem != null}
            onClick={() => run(() => callApi<GuestLinksStatus>("POST", "/api/guests/apply"))}
          >
            Apply
          </button>
        </div>
      </div>
      {error && <p className="error-text">{error}</p>}
      {status?.problem && (
        <div className="callout">
          <div className="v">{status.problem}</div>
        </div>
      )}
      {status && status.errors.length > 0 && (
        <div className="callout">
          <ul className="v">
            {status.errors.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </div>
      )}
      {steps.map((step) => (
        <div key={step} className="callout cloudflare-step">
          <GuestStepGuide step={step} />
        </div>
      ))}

      <h3>Who can open guest links</h3>
      <p className="small muted">
        The rules apply to every machine. A guest who matches one entry gets in. One entry per line.
      </p>
      {draft !== null && (
        <form
          className="stack tight"
          onSubmit={(e) => {
            e.preventDefault();
            const rules = fromDraft(draft);
            run(() => callApi<GuestLinksStatus>("POST", "/api/guests/rules", { rules }));
          }}
        >
          <div className="guest-rules">
            {RULE_FIELDS.map((field) => (
              <label key={field.key} className="field">
                <span className="t">{field.label}</span>
                <span className="hint">{field.hint}</span>
                <textarea
                  rows={3}
                  value={draft[field.key]}
                  placeholder={field.placeholder}
                  disabled={busy}
                  onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                />
              </label>
            ))}
          </div>
          {ownerOnly && !changed && (
            <p className="hint">No rules yet: only the owner emails can open guest links.</p>
          )}
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy || !changed}>
              Save and apply
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !changed}
              onClick={() => status && setDraft(toDraft(status.rules))}
            >
              Reset
            </button>
          </div>
        </form>
      )}

      <h3>Machines</h3>
      <p className="small muted">
        The switch sets <code>guestSharingEnabled</code> for the machine as a map change, then
        applies the Cloudflare setup of its host. Turning it off removes the Access apps that the
        portal made there.
      </p>
      {status === null ? (
        <p className="small muted">{busy ? "Loading…" : "No answer from the portal."}</p>
      ) : status.machines.length === 0 ? (
        <p className="small muted">No machines yet.</p>
      ) : (
        <ul className="list">
          {status.machines.map((machine) => (
            <MachineRow
              key={machine.machineId}
              machine={machine}
              busy={busy}
              toggle={(enabled) =>
                run(() =>
                  callApi<GuestLinksStatus>(
                    "POST",
                    `/api/machines/${encodeURIComponent(machine.machineId)}/guest-links`,
                    { enabled },
                  ),
                )
              }
            />
          ))}
        </ul>
      )}

      {status !== null && (
        <>
          <h3>Account and zone</h3>
          <ul className="list">
            <PartRow
              label="One-time PIN login"
              hint="The login method of guests. Apply adds it and never removes it, because other apps can use it."
              state={status.oneTimePin}
            />
            <PartRow
              label="Rate limit on /api/guest/"
              hint="100 requests per 10 seconds per IP address, then a block of 10 seconds."
              state={status.rateLimit}
            />
          </ul>
          <p className="hint">
            Open guest links in a private window. A guest login replaces the owner login of that
            host in the browser.
          </p>
        </>
      )}
    </div>
  );
}
