import { expect, it } from "vite-plus/test";
import { client, MAC, PHONE, threeMachines } from "./testMap.ts";
import { applyChanges } from "./map.ts";
import { approvalMatches, captureApproval, type ApprovalContext } from "./approval.ts";

const context = (): ApprovalContext => ({
  snapshot: { map: { ...threeMachines(), clients: [client()] } },
  pause: null,
  pending: [
    {
      thumbprint: "pending-key",
      email: "owner@example.com",
      describedAs: "Chrome",
      seenOn: MAC,
      state: "pending",
      firstSeenAt: "2026-10-01",
      lastSeenAt: "2026-10-01",
    },
  ],
});

it("stops an existing-client invite when its name, arrows, token or existence changes", () => {
  const before = context();
  const action = captureApproval(
    {
      _tag: "invite",
      request: { client: { _tag: "existing", clientId: PHONE }, arrows: [] },
    } as const,
    before,
  );
  expect(approvalMatches(action, before)).toBe(true);
  for (const clients of [
    [client({ name: "Renamed" })],
    [client({ serviceToken: { clientId: "new-token" } })],
    [],
  ]) {
    expect(
      approvalMatches(action, {
        ...before,
        snapshot: { map: { ...before.snapshot.map, clients } },
      }),
    ).toBe(false);
  }
  const map = applyChanges(before.snapshot.map, [
    {
      _tag: "setClientArrow",
      arrow: { client: PHONE, to: MAC, level: "admin", expiresAt: null, revertLevel: null },
    },
  ]).map;
  expect(approvalMatches(action, { ...before, snapshot: { map } })).toBe(false);
});

it("stops a new invite when its machine disappears or its name becomes occupied", () => {
  const before = context();
  const action = captureApproval(
    {
      _tag: "invite",
      request: {
        client: { _tag: "new", name: "Tablet" },
        arrows: [{ to: MAC, level: "standard" }],
      },
    } as const,
    before,
  );
  expect(
    approvalMatches(action, {
      ...before,
      snapshot: { map: { ...before.snapshot.map, machines: [] } },
    }),
  ).toBe(false);
  expect(
    approvalMatches(action, {
      ...before,
      snapshot: { map: { ...before.snapshot.map, clients: [client({ name: "Tablet" })] } },
    }),
  ).toBe(false);
});

it("checks a waiting key's identity and state, not its refreshing last-seen time", () => {
  const before = context();
  const action = captureApproval(
    {
      _tag: "approve",
      request: {
        thumbprint: "pending-key",
        client: { _tag: "existing", clientId: PHONE },
        arrows: [],
      },
    } as const,
    before,
  );
  const pending = before.pending![0]!;
  expect(
    approvalMatches(action, { ...before, pending: [{ ...pending, lastSeenAt: "2026-10-02" }] }),
  ).toBe(true);
  expect(approvalMatches(action, { ...before, pending: [{ ...pending, state: "rejected" }] })).toBe(
    false,
  );
  expect(
    approvalMatches(action, { ...before, pending: [{ ...pending, email: "other@example.com" }] }),
  ).toBe(false);
  expect(
    approvalMatches(action, { ...before, pending: [{ ...pending, firstSeenAt: "2026-10-02" }] }),
  ).toBe(false);
  expect(approvalMatches(action, { ...before, pending: [] })).toBe(false);
});

it("checks setting values and machine identity while allowing unrelated map edits", () => {
  const before = context();
  const action = captureApproval(
    {
      _tag: "changes",
      request: {
        summary: "Enforce",
        changes: [
          {
            _tag: "setSetting",
            machineId: MAC,
            scope: "server",
            key: "clientAccess",
            present: true,
            value: "enforce",
          },
        ],
      },
    } as const,
    before,
  );
  const unrelated = applyChanges(before.snapshot.map, [
    {
      _tag: "putNote",
      note: { id: "note", text: "Hello", color: "yellow", position: { x: 100, y: 100 } },
    },
  ]).map;
  expect(approvalMatches(action, { ...before, snapshot: { map: unrelated } })).toBe(true);
  const changed = applyChanges(before.snapshot.map, [
    {
      _tag: "setSetting",
      machineId: MAC,
      scope: "server",
      key: "clientAccess",
      present: true,
      value: "observe",
    },
  ]).map;
  expect(approvalMatches(action, { ...before, snapshot: { map: changed } })).toBe(false);
  const shared = applyChanges(before.snapshot.map, [
    {
      _tag: "setSetting",
      machineId: null,
      scope: "server",
      key: "clientAccess",
      present: true,
      value: "observe",
    },
  ]).map;
  expect(approvalMatches(action, { ...before, snapshot: { map: shared } })).toBe(false);
  expect(
    approvalMatches(action, {
      ...before,
      snapshot: { map: { ...before.snapshot.map, machines: [] } },
    }),
  ).toBe(false);
});

it("tracks pause identity, not display-only cut lists that can change for unrelated clients", () => {
  const before = {
    ...context(),
    pause: {
      pausedAt: "2026-10-01",
      by: { _tag: "owner", email: "owner@example.com", device: "Phone" },
      revision: 1,
      cut: [],
      cutClients: [{ client: PHONE, to: MAC, level: "standard" }],
    },
  } satisfies ApprovalContext;
  const action = captureApproval(
    {
      _tag: "changes",
      request: {
        summary: "Enforce",
        changes: [
          {
            _tag: "setSetting",
            machineId: MAC,
            scope: "server",
            key: "clientAccess",
            present: true,
            value: "enforce",
          },
        ],
      },
    } as const,
    before,
  );
  const after = {
    ...before,
    snapshot: { map: { ...before.snapshot.map, clients: [] } },
    pause: { ...before.pause, cutClients: [] },
  };
  expect(approvalMatches(action, after)).toBe(true);
  expect(approvalMatches(action, { ...after, pause: null })).toBe(false);
});
