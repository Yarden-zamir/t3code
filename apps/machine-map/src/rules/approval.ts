import * as Schema from "effect/Schema";
import type { MachineMapDocument } from "@t3tools/contracts/machineMap";
import { stableStringify } from "@t3tools/shared/relaySigning";

import {
  ApproveClientRequest,
  ChangesRequest,
  InviteRequest,
  type PauseView,
  type PendingClient,
} from "../api.ts";
import { applyChanges, machinesTouched } from "./map.ts";

export const APPROVAL_CHANGED = "This changed while you confirmed. Review and try again";

export const ApprovalAction = Schema.Union([
  Schema.TaggedStruct("invite", {
    request: InviteRequest,
    phone: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.TaggedStruct("approve", { request: ApproveClientRequest }),
  Schema.TaggedStruct("changes", { request: ChangesRequest }),
]);
export type ApprovalAction = typeof ApprovalAction.Type;
export type ApprovalKind = ApprovalAction["_tag"];

export interface ApprovalContext {
  readonly snapshot: { readonly map: MachineMapDocument };
  readonly pause: PauseView | null;
  readonly pending: ReadonlyArray<PendingClient> | null;
}

/** Only facts the owner is approving count; presence, last use and unrelated map edits do not. */
export function approvalState(action: ApprovalAction, context: ApprovalContext): string {
  const map = context.snapshot.map;
  const pause = context.pause && {
    pausedAt: context.pause.pausedAt,
    by: context.pause.by,
    revision: context.pause.revision,
  };
  if (action._tag === "changes") {
    const inverse = applyChanges(map, action.request.changes).inverse;
    const touched = machinesTouched({ changes: action.request.changes, inverse });
    return stableStringify({
      pause,
      inverse,
      machines: map.machines
        .filter((m) => touched === "all" || touched.has(m.id))
        .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      shared: action.request.changes.flatMap((c) =>
        c._tag === "setSetting"
          ? [
              {
                scope: c.scope,
                key: c.key,
                present: Object.hasOwn(map.settings.shared[c.scope], c.key),
                value: map.settings.shared[c.scope][c.key] ?? null,
              },
            ]
          : [],
      ),
    });
  }
  const request = action.request;
  const target = request.client;
  const client =
    target._tag === "existing"
      ? (map.clients.find((c) => c.id === target.clientId) ?? null)
      : (map.clients.find((c) => c.name.toLowerCase() === target.name.toLowerCase()) ?? null);
  const pending =
    action._tag === "approve"
      ? context.pending?.find((p) => p.thumbprint === action.request.thumbprint)
      : undefined;
  return stableStringify({
    pause,
    client,
    arrows: client
      ? map.clientArrows
          .filter((a) => a.client === client.id)
          .toSorted((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
      : [],
    machines: map.machines.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    // A waiting browser refreshes lastSeenAt while the owner is on the passkey page.
    pending: pending
      ? {
          thumbprint: pending.thumbprint,
          email: pending.email,
          describedAs: pending.describedAs,
          seenOn: pending.seenOn,
          firstSeenAt: pending.firstSeenAt,
          state: pending.state,
        }
      : null,
  });
}

export function approvalMatches(action: ApprovalAction, context: ApprovalContext): boolean {
  try {
    return (
      action.request.expectedState !== undefined &&
      action.request.expectedState === approvalState(action, context)
    );
  } catch {
    return false;
  }
}

export function captureApproval<T extends ApprovalAction>(action: T, context: ApprovalContext): T {
  return {
    ...action,
    request: { ...action.request, expectedState: approvalState(action, context) },
  };
}
