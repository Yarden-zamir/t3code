/**
 * MM-1218, MM-1219: the Cloudflare view. Every Cloudflare part that the portal relies on, with its
 * state, and one Repair that runs the code of "Set up approvals" and the guests "Apply" too.
 */
import { useEffect, useState } from "react";

import type {
  CloudflarePart,
  CloudflarePartState,
  CloudflareStatus,
  CloudflareStep,
  GuestCloudflareStep,
  TokenPermissionCheck,
} from "../api.ts";
import { callApi } from "./apiClient.ts";
import { CloudflareStepGuide } from "./Approvals.tsx";
import { GuestStepGuide } from "./GuestLinks.tsx";

const ACTION = "Repair";

const errorText = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);

function StateSticker({ state }: { state: CloudflarePartState }) {
  switch (state._tag) {
    case "ready":
      return <span className="sticker ok">ready</span>;
    case "off":
      return <span className="sticker none">off</span>;
    case "changed":
      return <span className="sticker wait">changed</span>;
    case "missing":
      return <span className="sticker wait">missing</span>;
    case "manual":
      return <span className="sticker warn">manual step</span>;
  }
}

const stateText = (state: CloudflarePartState): string | null => {
  switch (state._tag) {
    case "ready":
    case "off":
      return state.note;
    case "changed":
    case "missing":
      return `${state.reason} Repair fixes it.`;
    case "manual":
      return state.reason;
  }
};

function PartRow({ part }: { part: CloudflarePart }) {
  const text = stateText(part.state);
  return (
    <li className="item static">
      <span className="grow">
        <b>{part.label}</b>
        {part.hint !== "" && <span className="sub">{part.hint}</span>}
        {text !== null && <span className="sub">{text}</span>}
      </span>
      <StateSticker state={part.state} />
    </li>
  );
}

/** MM-1209: the guide of a manual step. */
function StepGuide({ step }: { step: CloudflareStep | GuestCloudflareStep }) {
  return (
    <div className="callout cloudflare-step">
      {step === "allowPasskey" || step === "appLauncher" ? (
        <CloudflareStepGuide step={step} action={ACTION} />
      ) : (
        <GuestStepGuide step={step} action={ACTION} />
      )}
    </div>
  );
}

function PermissionRow({ check }: { check: TokenPermissionCheck }) {
  return (
    <li className="item static">
      <span className="grow">
        <b>{check.permission}</b>
      </span>
      {check.granted === true ? (
        <span className="sticker ok">can read</span>
      ) : check.granted === false ? (
        <span className="sticker warn">missing</span>
      ) : (
        <span className="sticker none">unknown</span>
      )}
    </li>
  );
}

export function CloudflareView() {
  const [status, setStatus] = useState<CloudflareStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const run = (work: () => Promise<CloudflareStatus>) => {
    setBusy(true);
    work()
      .then((next) => {
        setStatus(next);
        setError(null);
      })
      .catch((reason: unknown) => setError(errorText(reason)))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    let current = true;
    callApi<CloudflareStatus>("GET", "/api/cloudflare")
      .then((next) => current && setStatus(next))
      .catch((reason: unknown) => current && setError(errorText(reason)))
      .finally(() => current && setBusy(false));
    return () => {
      current = false;
    };
  }, []);

  // One guide per step, also when two parts need the same step.
  const steps = [
    ...new Set(
      (status?.parts ?? []).flatMap((part) =>
        part.state._tag === "manual" && part.state.step !== null ? [part.state.step] : [],
      ),
    ),
  ];

  return (
    <div className="card view stack">
      <div className="view-head">
        <div>
          <h2>Cloudflare</h2>
          <p className="small muted">
            Every Cloudflare part that the portal relies on. Repair makes what is missing and fixes
            what changed, where the portal may. A manual step names what to do in Cloudflare.
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => run(() => callApi<CloudflareStatus>("GET", "/api/cloudflare"))}
          >
            {busy ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || status?.problem != null}
            onClick={() => run(() => callApi<CloudflareStatus>("POST", "/api/cloudflare/repair"))}
          >
            Repair
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
        <StepGuide key={step} step={step} />
      ))}

      <h3>Parts</h3>
      {status === null ? (
        <p className="small muted">{busy ? "Loading…" : "No answer from the portal."}</p>
      ) : (
        <ul className="list">
          {status.parts.map((part) => (
            <PartRow key={part.key} part={part} />
          ))}
        </ul>
      )}

      {status !== null && status.permissions.length > 0 && (
        <>
          <h3>Portal token</h3>
          <p className="small muted">
            The portal reads one thing with each permission of the CF_API_TOKEN. A read does not
            prove edit rights. The README lists what each permission is for.
          </p>
          <ul className="list">
            {status.permissions.map((check) => (
              <PermissionRow key={check.permission} check={check} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
