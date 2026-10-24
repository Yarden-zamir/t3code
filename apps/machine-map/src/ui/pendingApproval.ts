import * as Schema from "effect/Schema";

import { InviteRequest } from "../api.ts";
import {
  ApprovalAction,
  captureApproval,
  type ApprovalContext,
  type ApprovalKind,
} from "../rules/approval.ts";

const KEY = "machine-map:pending-invite";
const MAX_AGE_MS = 10 * 60_000;
const PendingApproval = Schema.Struct({
  action: ApprovalAction,
  savedAt: Schema.Number,
});
export type PendingApproval = typeof PendingApproval.Type;
const decode = Schema.decodeUnknownSync(PendingApproval);
const decodeLegacy = Schema.decodeUnknownSync(
  Schema.Struct({ request: InviteRequest, phone: Schema.Boolean, savedAt: Schema.Number }),
);

/** Keep only the owner's request across Cloudflare, never an invite code or token. */
export function savePendingApproval(
  pending: PendingApproval,
  storage: Pick<Storage, "setItem"> = sessionStorage,
) {
  try {
    storage.setItem(KEY, JSON.stringify(pending));
  } catch {
    throw new Error("The browser could not keep this approval. Allow tab storage and try again.");
  }
}

export function readPendingApproval(
  storage: Pick<Storage, "getItem"> = sessionStorage,
  now = Date.now(),
) {
  let saved: string | null;
  try {
    saved = storage.getItem(KEY);
  } catch {
    return { _tag: "missing" } as const;
  }
  if (!saved) return { _tag: "missing" } as const;
  try {
    const data: unknown = JSON.parse(saved);
    let pending: PendingApproval;
    try {
      pending = decode(data);
    } catch {
      const legacy = decodeLegacy(data);
      pending = {
        action: { _tag: "invite", request: legacy.request, phone: legacy.phone },
        savedAt: legacy.savedAt,
      };
    }
    const age = now - pending.savedAt;
    return { _tag: age >= 0 && age < MAX_AGE_MS ? "ready" : "expired", pending } as const;
  } catch {
    return { _tag: "invalid" } as const;
  }
}

export function clearPendingApproval(storage: Pick<Storage, "removeItem"> = sessionStorage) {
  storage.removeItem(KEY);
}

export function finishApproval() {
  try {
    clearPendingApproval();
  } finally {
    const url = new URL(location.href);
    url.searchParams.delete("resume");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
}

export const approvalPasskeyUrl = (kind: ApprovalKind, hash: string) =>
  `/api/grant/start?resume=${kind}&then=${encodeURIComponent(hash)}`;

export const pendingApproval = (
  action: ApprovalAction,
  context: ApprovalContext,
  now = Date.now(),
): PendingApproval => ({ action: captureApproval(action, context), savedAt: now });

export function startApproval(pending: PendingApproval) {
  savePendingApproval(pending);
  location.href = approvalPasskeyUrl(pending.action._tag, location.hash);
}

export const approvalExpired = (pending: PendingApproval, now = Date.now()) =>
  now < pending.savedAt || now - pending.savedAt >= MAX_AGE_MS;

export type ApprovalReturn = ReturnType<typeof readPendingApproval>;
