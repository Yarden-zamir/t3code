import { expect, it } from "vite-plus/test";
import { ClientId, MachineId } from "@t3tools/contracts/machineMap";
import { threeMachines } from "../rules/testMap.ts";
import { approvalMatches } from "../rules/approval.ts";
import {
  clearPendingApproval,
  approvalPasskeyUrl,
  readPendingApproval,
  savePendingApproval,
  pendingApproval,
} from "./pendingApproval.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

const context = { snapshot: { map: threeMachines() }, pause: null, pending: [] };

it("keeps the exact name, arrows, map point and precondition through repeated StrictMode reads", () => {
  const saved = storage();
  const pending = pendingApproval(
    {
      _tag: "invite",
      phone: true,
      request: {
        client: { _tag: "new", name: "Pixel", position: { x: -200, y: 1900 } },
        arrows: [{ to: MachineId.make("mac"), level: "read" }],
      },
    },
    context,
    1000,
  );
  savePendingApproval(pending, saved);
  expect(readPendingApproval(saved, 2000)).toEqual({ _tag: "ready", pending });
  expect(readPendingApproval(saved, 2000)).toEqual({ _tag: "ready", pending });
  clearPendingApproval(saved);
  expect(readPendingApproval(saved, 2000)).toEqual({ _tag: "missing" });
});

it("retains expired requests for explicit retry but never calls them ready", () => {
  const saved = storage();
  const pending = pendingApproval(
    { _tag: "invite", request: { client: { _tag: "new", name: "Phone" }, arrows: [] } },
    context,
    1000,
  );
  savePendingApproval(pending, saved);
  expect(readPendingApproval(saved, 601000)).toEqual({ _tag: "expired", pending });
  expect(readPendingApproval(saved, 999)).toEqual({ _tag: "expired", pending });
  expect(readPendingApproval({ getItem: () => "not json" })).toEqual({ _tag: "invalid" });
});

it.each(["invite", "approve", "changes"] as const)(
  "marks the %s return without putting the request in the URL",
  (kind) => {
    const url = new URL(
      approvalPasskeyUrl(kind, "#/clients/client/a b"),
      "https://portal.example.com",
    );
    expect(url.pathname).toBe("/api/grant/start");
    expect(url.searchParams.get("resume")).toBe(kind);
    expect(url.searchParams.get("then")).toBe("#/clients/client/a b");
  },
);

it("recovers old invite data for review, never for unchecked automatic execution", () => {
  const request = {
    client: { _tag: "existing", clientId: ClientId.make("client-phone") },
    arrows: [],
  };
  const state = readPendingApproval(
    { getItem: () => JSON.stringify({ request, phone: false, savedAt: 1000 }) },
    2000,
  );
  expect(state._tag).toBe("ready");
  if (!("pending" in state)) throw new Error("No saved invite");
  expect(state.pending.action.request).toEqual(request);
  expect(approvalMatches(state.pending.action, context)).toBe(false);
});

it("reports unavailable tab storage instead of leaving without a saved request", () => {
  const pending = pendingApproval(
    {
      _tag: "changes",
      request: {
        summary: "Enforce",
        changes: [
          {
            _tag: "setSetting",
            machineId: MachineId.make("mac"),
            scope: "server",
            key: "clientAccess",
            present: true,
            value: "enforce",
          },
        ],
      },
    },
    context,
  );
  expect(() =>
    savePendingApproval(pending, {
      setItem: () => {
        throw new Error("blocked");
      },
    }),
  ).toThrow("Allow tab storage and try again");
});
