import * as NodeSqlite from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { MACHINE_MAP_PROTOCOL, MachineMapDocument } from "@t3tools/contracts/machineMap";

import { CloudflareApi } from "./cloudflare.ts";
import type { Env } from "./env.ts";
import { MachineMapObject, type OwnerContext } from "./MachineMapObject.ts";
import { emptyMap } from "./rules/map.ts";
import { arrowChange } from "./rules/access.ts";
import { MAC, threeMachines, VPS, WIN } from "./rules/testMap.ts";
import { GUEST_RATE_LIMIT_RULE } from "./guestLinks.ts";
import { APPROVAL_CHANGED, captureApproval } from "./rules/approval.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: DurableObjectState;
    readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const owner: OwnerContext = {
  email: "owner@example.com",
  signInId: "device-1",
  device: "Phone",
  browser: "Chrome",
  place: "Test",
};
const NOW = "2026-10-20T08:00:00.000Z";
const databases: Array<NodeSqlite.DatabaseSync> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal(
    "WebSocketRequestResponsePair",
    class {
      readonly request: string;
      readonly response: string;
      constructor(request: string, response: string) {
        this.request = request;
        this.response = response;
      }
    },
  );
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * `true` starts with three machines and no arrows; a map starts with that map. `connectMac` gives
 * MAC an open socket, so the test reads what the portal sends it.
 */
function portal(machines: boolean | MachineMapDocument = false, connectMac = false) {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO meta VALUES ('map', ?)").run(
    JSON.stringify(
      machines === false ? emptyMap() : machines === true ? threeMachines() : machines,
    ),
  );
  db.prepare("INSERT INTO meta VALUES ('absolute_places', ?)").run(NOW);
  const send = vi.fn();
  // What the portal sends to the machine MAC, for example the result of an agent tool.
  const sendToMac = vi.fn();
  let alarmAt: number | null = null;
  const setAlarm = vi.fn(async (at: number) => {
    alarmAt = at;
  });
  const deleteAlarm = vi.fn(async () => {
    alarmAt = null;
  });
  // Machine sockets that a test opens with `machineSocket`, by machine id.
  const machineSockets = new Map<string, WebSocket>();
  const ctx = {
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: (tag: string) =>
      tag === "page"
        ? [{ send }]
        : connectMac && tag === `machine:${MAC}`
          ? [{ send: sendToMac }]
          : [...machineSockets].flatMap(([id, ws]) => (tag === `machine:${id}` ? [ws] : [])),
    waitUntil: (_work: Promise<unknown>) => {},
    storage: {
      sql: {
        exec(query: string, ...bindings: Array<string | number | null>) {
          if (query.trim().startsWith("CREATE")) {
            db.exec(query);
            return { toArray: () => [] };
          }
          const rows = db.prepare(query).all(...bindings);
          return { toArray: () => rows };
        },
      },
      transactionSync: (work: () => unknown) => work(),
      setAlarm,
      getAlarm: async () => alarmAt,
      deleteAlarm,
    },
  } as unknown as DurableObjectState;
  const env = {
    SECRET_KEY: btoa("a".repeat(32)),
    ACCOUNT_ID: "account",
    OWNER_EMAILS: owner.email,
    TEAM_DOMAIN: "team.cloudflareaccess.com",
    DEV_FAKE_ACCESS: "1",
    ...(machines === false ? {} : { CF_API_TOKEN: "test-only" }),
  } as Env;
  return {
    db,
    ctx,
    env,
    object: new MachineMapObject(ctx, env),
    send,
    sendToMac,
    setAlarm,
    deleteAlarm,
    machineSockets,
  };
}

it("reads push registration without restoring a subscription deleted by sign-out", async () => {
  const { object, db } = portal();
  const request = {
    endpoint: "https://push.example.com/device",
    keys: { p256dh: "key", auth: "auth" },
  };
  await object.subscribePush(owner, request);
  expect(await object.pushStatus(owner, request)).toEqual({
    ok: true,
    value: { subscribed: true },
  });
  expect((await object.signOutEverywhere(owner)).ok).toBe(true);
  for (let i = 0; i < 2; i++) {
    expect(await object.pushStatus(owner, request)).toEqual({
      ok: true,
      value: { subscribed: false },
    });
  }
  expect(db.prepare("SELECT * FROM push_subscriptions").all()).toEqual([]);
  await object.subscribePush(owner, request);
  expect(await object.pushStatus(owner, request)).toEqual({
    ok: true,
    value: { subscribed: true },
  });
});

it("wipes an unconfirmed rotation at its 24-hour deadline but keeps the rejoin marker through restart", async () => {
  const { object, db, ctx, env, send, setAlarm } = portal(true);
  db.prepare("INSERT INTO machine_tokens VALUES (?, ?)").run(MAC, "token-id");
  const rotate = vi
    .spyOn(CloudflareApi.prototype, "rotateServiceToken")
    .mockResolvedValue("new-secret");
  expect(await object.rotateToken(owner, MAC)).toEqual({
    ok: true,
    value: { machineId: MAC, delivered: false },
  });
  const deadline = "2026-10-21T08:00:00.000Z";
  expect(rotate).toHaveBeenCalledWith("token-id", deadline);
  vi.setSystemTime(new Date(Date.parse(deadline) - 1));
  await object.alarm();
  expect(db.prepare("SELECT sealed_secret FROM rotations").get()?.sealed_secret).not.toBe("");
  setAlarm.mockClear();
  vi.setSystemTime(new Date(deadline));
  await object.alarm();
  expect(db.prepare("SELECT sealed_secret, expires_at FROM rotations").get()).toEqual({
    sealed_secret: "",
    expires_at: deadline,
  });
  expect(send.mock.calls.map(([text]) => JSON.parse(text))).toContainEqual({
    _tag: "rotations",
    rotations: [
      { machineId: MAC, createdAt: "2026-10-20T08:00:00.000Z", expiresAt: deadline, expired: true },
    ],
  });
  expect(setAlarm).not.toHaveBeenCalled();
  expect(ctx.storage.deleteAlarm).toHaveBeenCalled();
  const restarted = new MachineMapObject(ctx, env);
  expect(await restarted.rotateToken(owner, MAC)).toEqual({
    ok: false,
    status: 409,
    error: "Join again with a new code before rotating this token.",
  });
  expect(rotate).toHaveBeenCalledOnce();
  const join = await restarted.newJoinCode(owner, MAC, { tokenSecret: "recovery-secret" });
  expect(join.ok).toBe(true);
  if (!join.ok) throw new Error(join.error);
  expect(db.prepare("SELECT sealed_secret FROM rotations").get()?.sealed_secret).toBe("");
  expect((await restarted.enroll("127.0.0.1", join.value.code)).ok).toBe(true);
  expect(db.prepare("SELECT * FROM rotations").all()).toEqual([]);
});

it("does not mark a confirmed rotation as needing a rejoin after the deadline", async () => {
  const { object, db } = portal(true);
  db.prepare("INSERT INTO machine_tokens VALUES (?, ?)").run(MAC, "token-id");
  vi.spyOn(CloudflareApi.prototype, "rotateServiceToken").mockResolvedValue("new-secret");
  const endPrevious = vi
    .spyOn(CloudflareApi.prototype, "endPreviousSecret")
    .mockResolvedValue(undefined);
  await object.rotateToken(owner, MAC);
  const socket = {
    deserializeAttachment: () => ({ kind: "machine", machineId: MAC }),
  } as WebSocket;
  await object.webSocketMessage(
    socket,
    JSON.stringify({ _tag: "rotated", tokenClientId: "mac.access" }),
  );
  expect(endPrevious).toHaveBeenCalledWith("token-id");
  vi.setSystemTime(new Date("2026-10-22T08:00:00.000Z"));
  await object.alarm();
  expect(db.prepare("SELECT * FROM rotations").all()).toEqual([]);
});

it("supersedes a waiting rotation when the owner makes a join code", async () => {
  const { object, db } = portal(true);
  db.prepare("INSERT INTO machine_tokens VALUES (?, ?)").run(MAC, "token-id");
  vi.spyOn(CloudflareApi.prototype, "rotateServiceToken").mockResolvedValue("superseded-secret");
  await object.rotateToken(owner, MAC);
  const join = await object.newJoinCode(owner, MAC, { tokenSecret: "recovery-secret" });
  expect(join.ok).toBe(true);
  if (!join.ok) throw new Error(join.error);
  expect(db.prepare("SELECT sealed_secret, expires_at FROM rotations").get()).toEqual({
    sealed_secret: "",
    expires_at: NOW,
  });
  expect((await object.enroll("127.0.0.1", join.value.code)).ok).toBe(true);
  expect(db.prepare("SELECT * FROM rotations").all()).toEqual([]);
});

const decodeMapDocument = Schema.decodeUnknownSync(MachineMapDocument);
const readMap = (db: NodeSqlite.DatabaseSync) =>
  decodeMapDocument(
    JSON.parse(String(db.prepare("SELECT value FROM meta WHERE key = 'map'").get()?.value)),
  );

it("refuses stale owner-only changes at the server, without overwriting a newer value", async () => {
  const { object, db } = portal(true);
  const context = { snapshot: { map: readMap(db) }, pause: null, pending: [] };
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
    context,
  );
  await object.changes(
    owner,
    {
      summary: "Observe",
      changes: [
        {
          _tag: "setSetting",
          machineId: MAC,
          scope: "server",
          key: "clientAccess",
          present: true,
          value: "observe",
        },
      ],
    },
    true,
  );
  expect(await object.changes(owner, action.request, true)).toEqual({
    ok: false,
    status: 409,
    error: APPROVAL_CHANGED,
  });
  expect(readMap(db).settings.overrides[MAC]?.server.clientAccess).toBe("observe");
});

it("allows a saved changes request after an unrelated note edit", async () => {
  const { object, db } = portal(true);
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
    { snapshot: { map: readMap(db) }, pause: null, pending: [] },
  );
  await object.changes(owner, {
    summary: "Note",
    changes: [
      {
        _tag: "putNote",
        note: { id: "note", text: "Unrelated", color: "yellow", position: { x: 100, y: 100 } },
      },
    ],
  });
  expect((await object.changes(owner, action.request, true)).ok).toBe(true);
  expect(readMap(db).settings.overrides[MAC]?.server.clientAccess).toBe("enforce");
});

it("rechecks a browser key after the asynchronous approval check", async () => {
  const { object, db } = portal(true);
  const pending = {
    thumbprint: "pending-key",
    email: owner.email,
    describedAs: "Chrome",
    seenOn: MAC,
    state: "pending" as const,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  };
  db.prepare("INSERT INTO pending_clients VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    pending.thumbprint,
    pending.describedAs,
    pending.email,
    MAC,
    pending.firstSeenAt,
    pending.lastSeenAt,
    pending.state,
  );
  const action = captureApproval(
    {
      _tag: "approve",
      request: {
        thumbprint: pending.thumbprint,
        client: { _tag: "new", name: "Browser" },
        arrows: [{ to: MAC, level: "standard" }],
      },
    } as const,
    { snapshot: { map: readMap(db) }, pause: null, pending: [pending] },
  );
  const approving = object.approveClient(owner, "localhost", action.request);
  db.prepare("UPDATE pending_clients SET email = ? WHERE thumbprint = ?").run(
    "changed@example.com",
    pending.thumbprint,
  );
  expect(await approving).toEqual({ ok: false, status: 409, error: APPROVAL_CHANGED });
  expect(readMap(db).clients).toEqual([]);
  db.prepare("UPDATE pending_clients SET email = ? WHERE thumbprint = ?").run(
    owner.email,
    pending.thumbprint,
  );
  expect((await object.approveClient(owner, "localhost", action.request)).ok).toBe(true);
  expect(readMap(db).clients[0]?.keys[0]?.thumbprint).toBe(pending.thumbprint);
});

it("rechecks an invite after asynchronous work, without replacing the previous invite", async () => {
  const { object, db } = portal(true);
  const initial = captureApproval(
    { _tag: "invite", request: { client: { _tag: "new", name: "Phone" }, arrows: [] } } as const,
    { snapshot: { map: readMap(db) }, pause: null, pending: [] },
  );
  const first = await object.createInvite(owner, "localhost", initial.request);
  if (!first.ok) throw new Error(first.error);
  const previous = db.prepare("SELECT code_hash FROM client_invites").get()?.code_hash;
  const action = captureApproval(
    {
      _tag: "invite",
      request: { client: { _tag: "existing", clientId: first.value.clientId }, arrows: [] },
    } as const,
    { snapshot: { map: readMap(db) }, pause: null, pending: [] },
  );
  const inviting = object.createInvite(owner, "localhost", action.request);
  await object.changes(owner, {
    summary: "New access",
    changes: [
      {
        _tag: "setClientArrow",
        arrow: {
          client: first.value.clientId,
          to: MAC,
          level: "admin",
          expiresAt: null,
          revertLevel: null,
        },
      },
    ],
  });
  expect(await inviting).toEqual({ ok: false, status: 409, error: APPROVAL_CHANGED });
  expect(db.prepare("SELECT code_hash FROM client_invites").get()?.code_hash).toBe(previous);
});

it("records a run that a machine reports for History, once per run", async () => {
  const { object, db, send } = portal(true);
  const socket = {
    deserializeAttachment: () => ({ kind: "machine", machineId: MAC }),
  } as WebSocket;
  const report = {
    id: "run-1",
    at: NOW,
    from: "vps",
    threadId: "thread-1",
    threadTitle: "Fix the build",
    command: "make test",
    cwd: "/home/t3",
    outcome: "exited",
    exitCode: 2,
    durationMs: 40,
  };
  await object.webSocketMessage(socket, JSON.stringify({ _tag: "execRan", report }));
  // A report sent again after a reconnect counts once.
  await object.webSocketMessage(socket, JSON.stringify({ _tag: "execRan", report }));
  expect(db.prepare("SELECT id FROM exec_log").all()).toEqual([{ id: "run-1" }]);
  // MM-1908: the machine that reported the run is the one that ran it.
  expect(send.mock.calls.map(([text]) => JSON.parse(text)).at(-1)).toEqual({
    _tag: "execs",
    execs: [{ ...report, to: MAC }],
  });
});

it("records a refusal that the calling machine reports, and only its own", async () => {
  const { object, db, send } = portal(true);
  const socket = {
    deserializeAttachment: () => ({ kind: "machine", machineId: MAC }),
  } as WebSocket;
  const refusal = {
    id: "refused-1",
    at: NOW,
    from: MAC,
    threadId: "thread-1",
    threadTitle: "Fix the build",
    command: "make test",
    cwd: "~",
    outcome: "refused",
    exitCode: null,
    durationMs: 0,
    reason: "The arrow does not allow exec.",
    target: "vps",
  };
  await object.webSocketMessage(socket, JSON.stringify({ _tag: "execRan", report: refusal }));
  // MAC cannot report a refusal in the name of another caller.
  await object.webSocketMessage(
    socket,
    JSON.stringify({ _tag: "execRan", report: { ...refusal, id: "refused-2", from: "vps" } }),
  );
  expect(db.prepare("SELECT id FROM exec_log").all()).toEqual([{ id: "refused-1" }]);
  expect(send.mock.calls.map(([text]) => JSON.parse(text)).at(-1)).toEqual({
    _tag: "execs",
    execs: [{ ...refusal, to: "vps" }],
  });
});

it("moves the shared sidebar group settings of the map to the tab keys once", () => {
  const { db, ctx, env } = portal(true);
  const map = readMap(db);
  const legacy = {
    ...map,
    settings: {
      shared: {
        server: {
          sidebarGroups: { groups: [{ id: "a", name: "A", rules: [] }] },
          keybindings: [{ key: "1", command: "sidebar.group.1" }],
        },
        client: { sidebarGroupsEnabled: true },
      },
      overrides: { [MAC]: { server: { mobileSidebarGroups: true }, client: {} } },
    },
  };
  db.prepare("UPDATE meta SET value = ? WHERE key = 'map'").run(JSON.stringify(legacy));
  db.prepare("DELETE FROM meta WHERE key = 'sidebar_tab_keys'").run();

  expect(new MachineMapObject(ctx, env)).toBeInstanceOf(MachineMapObject);
  const moved = {
    shared: {
      server: {
        sidebarTabs: { tabs: [{ id: "a", name: "A", rules: [] }] },
        keybindings: [{ key: "1", command: "sidebar.tab.1" }],
      },
      client: { sidebarTabsEnabled: true },
    },
    overrides: { [MAC]: { server: { mobileSidebarTabs: true }, client: {} } },
  };
  expect(readMap(db).settings).toEqual(moved);

  // Once: an older machine that shares the old key again keeps it apart from the new one.
  db.prepare("UPDATE meta SET value = ? WHERE key = 'map'").run(JSON.stringify(legacy));
  expect(new MachineMapObject(ctx, env)).toBeInstanceOf(MachineMapObject);
  expect(readMap(db).settings).toEqual(legacy.settings);
});

it("an undo or a restore of a revision from before the tab keys sets the new keys (MM-415)", async () => {
  const { object, db, ctx, env } = portal(true);
  const setGroups = async (name: string) => {
    const result = await object.changes(owner, {
      summary: `Groups ${name}`,
      changes: [
        {
          _tag: "setSetting",
          machineId: null,
          scope: "server",
          key: "sidebarGroups",
          present: true,
          value: { groups: [{ id: "a", name, rules: [] }] },
        },
      ],
    });
    expect(result.ok).toBe(true);
    return readMap(db).revision;
  };
  await setGroups("A");
  const second = await setGroups("B");
  // The new version moves the keys of the map when it starts.
  db.prepare("DELETE FROM meta WHERE key = 'sidebar_tab_keys'").run();
  const moved = new MachineMapObject(ctx, env);
  const server = () => readMap(db).settings.shared.server;
  expect(server()).toEqual({ sidebarTabs: { tabs: [{ id: "a", name: "B", rules: [] }] } });

  expect((await moved.undo(owner, second)).ok).toBe(true);
  expect(server()).toEqual({ sidebarTabs: { tabs: [{ id: "a", name: "A", rules: [] }] } });

  expect((await moved.restore(owner, second)).ok).toBe(true);
  expect(server()).toEqual({ sidebarTabs: { tabs: [{ id: "a", name: "B", rules: [] }] } });
});

it("drops stored pair card places once, so old revisions and proposals still decode (MM-1108)", async () => {
  const { object, db, ctx, env } = portal(true);
  const note = { id: "n1", text: "Hi", color: "yellow", position: { x: 10, y: 20 } } as const;
  expect(
    (await object.changes(owner, { summary: "Note", changes: [{ _tag: "putNote", note }] })).ok,
  ).toBe(true);
  const revision = readMap(db).revision;
  const placed = { _tag: "placePair", a: MAC, b: VPS, offset: { along: 0.5, aside: 20 } };
  const withPlaces = (text: string) =>
    JSON.stringify({
      ...JSON.parse(text),
      pairPlacements: [{ a: MAC, b: VPS, along: 0.5, aside: 20 }],
    });
  const row = db.prepare("SELECT data, map FROM revisions WHERE revision = ?").get(revision);
  const data = JSON.parse(String(row?.data));
  db.prepare("UPDATE revisions SET data = ?, map = ? WHERE revision = ?").run(
    JSON.stringify({ ...data, changes: [...data.changes, placed], inverse: [placed] }),
    withPlaces(String(row?.map)),
    revision,
  );
  db.prepare("UPDATE meta SET value = ? WHERE key = 'map'").run(
    withPlaces(String(db.prepare("SELECT value FROM meta WHERE key = 'map'").get()?.value)),
  );
  db.prepare("INSERT INTO proposals VALUES (?, ?)").run(
    "p1",
    JSON.stringify({
      id: "p1",
      at: NOW,
      expiresAt: "2026-10-21T08:00:00.000Z",
      actor: { _tag: "agent", machineId: MAC, threadId: null, threadTitle: null },
      summary: "Move a card",
      changes: [placed],
      reason: "map-role",
    }),
  );
  db.prepare("DELETE FROM meta WHERE key = 'dropped_pair_placements'").run();

  const moved = new MachineMapObject(ctx, env);
  expect(db.prepare("SELECT value FROM meta WHERE key = 'map'").get()?.value).not.toContain(
    "pairPlacements",
  );
  const history = await moved.history(owner, null, 10);
  expect(history.ok && history.value.revisions[0]?.changes).toEqual([{ _tag: "putNote", note }]);
  expect(history.ok && history.value.revisions[0]?.inverse).toEqual([]);
  expect((await moved.mapAt(owner, revision)).ok).toBe(true);
  expect(
    String(db.prepare("SELECT data FROM proposals WHERE id = 'p1'").get()?.data),
  ).not.toContain("placePair");
});

describe("owner-only grants (MM-803)", () => {
  const macSocket = {
    deserializeAttachment: () => ({ kind: "machine", machineId: MAC }),
  } as WebSocket;
  /** MAC has the map role edit, and VPS uses WIN at `standard` with agent tools. */
  const linkedMap = (): MachineMapDocument => ({
    ...threeMachines(),
    machines: threeMachines().machines.map((m) => (m.id === MAC ? { ...m, mapRole: "edit" } : m)),
    arrows: [
      {
        from: VPS,
        to: WIN,
        level: "standard",
        agentTools: true,
        exec: false,
        expiresAt: null,
        revertLevel: null,
      },
    ],
  });
  const setAccess = (object: MachineMapObject, input: Record<string, unknown>) =>
    object.webSocketMessage(
      macSocket,
      JSON.stringify({
        _tag: "toolCall",
        requestId: "request-1",
        tool: "machines_set_access",
        input: { from: VPS, to: WIN, ...input },
        threadId: "thread-1",
        threadTitle: "Tidy the map",
      }),
    );
  const toolResult = (sendToMac: ReturnType<typeof vi.fn>) =>
    sendToMac.mock.calls
      .map(([text]) => JSON.parse(text))
      .find((message) => message._tag === "toolResult");

  it("turns a raise by an edit agent into a proposal and changes nothing", async () => {
    for (const input of [{ level: "admin" }, { level: "standard", exec: true }]) {
      const { object, db, sendToMac } = portal(linkedMap(), true);
      await setAccess(object, input);
      expect(toolResult(sendToMac)).toMatchObject({
        ok: true,
        result: { _tag: "proposed", reason: "owner-only" },
      });
      expect(readMap(db).arrows).toEqual(linkedMap().arrows);
      expect(db.prepare("SELECT id FROM proposals").all()).toHaveLength(1);
    }
  });

  it("applies a lower level from an edit agent at once", async () => {
    const { object, db, sendToMac } = portal(linkedMap(), true);
    await setAccess(object, { level: "read" });
    expect(toolResult(sendToMac)).toMatchObject({ ok: true, result: { _tag: "applied" } });
    expect(readMap(db).arrows[0]).toMatchObject({ from: VPS, to: WIN, level: "read" });
    expect(db.prepare("SELECT id FROM proposals").all()).toEqual([]);
  });

  it("applies a raise by the owner at once", async () => {
    const { object, db } = portal(linkedMap());
    const map = readMap(db);
    const raise = arrowChange(map, {
      from: VPS,
      to: WIN,
      level: "admin",
      exec: true,
      expiresAt: null,
    });
    expect(
      await object.changes(owner, { summary: "VPS uses WIN: admin", changes: [raise] }),
    ).toMatchObject({
      ok: true,
      value: { _tag: "applied" },
    });
    expect(readMap(db).arrows[0]).toMatchObject({ level: "admin", agentTools: true, exec: true });
  });
});

it("records a forwarded call for History without arguments, once per call", async () => {
  const { object, db, send } = portal(true);
  const socket = {
    deserializeAttachment: () => ({ kind: "machine", machineId: MAC }),
  } as WebSocket;
  const report = {
    id: "call-1",
    at: NOW,
    to: VPS,
    threadId: "thread-1",
    threadTitle: "Fix the build",
    tool: "t3_thread_launch",
    outcome: "succeeded",
  };
  // A report that carries arguments by mistake stores none of them.
  const withArguments = { ...report, arguments: { message: "secret plan" } };
  await object.webSocketMessage(
    socket,
    JSON.stringify({ _tag: "callForwarded", report: withArguments }),
  );
  await object.webSocketMessage(socket, JSON.stringify({ _tag: "callForwarded", report }));
  expect(db.prepare("SELECT id FROM call_log").all()).toEqual([{ id: "call-1" }]);
  expect(String(db.prepare("SELECT data FROM call_log").get()?.data)).not.toContain("secret");
  // MM-1922: the machine that reported the call is the one that forwarded it.
  expect(send.mock.calls.map(([text]) => JSON.parse(text)).at(-1)).toEqual({
    _tag: "calls",
    calls: [{ ...report, from: MAC }],
  });
});

describe("storage use of machine messages (MM-1001, MM-1503)", () => {
  /** A machine socket that keeps its attachment through hibernation, like the runtime. */
  const machineSocket = (machineId: string) => {
    let attachment: unknown = { kind: "machine", machineId };
    return {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      serializeAttachment: (value: unknown) => {
        attachment = structuredClone(value);
      },
      deserializeAttachment: () => attachment,
    } as unknown as WebSocket;
  };
  const status = (change: {
    cpuPercent?: number;
    uptimeSeconds?: number;
    runningTurns?: number;
  }) => ({
    t3Version: "0.0.45",
    build: "release",
    hostname: null,
    uptimeSeconds: 0,
    runningTurns: 0,
    waitingThreads: 0,
    scheduledTasks: 0,
    updateWaiting: null,
    cpuPercent: 10,
    memoryPercent: 50,
    commands: [],
    clients: [],
    ...change,
  });
  const sample = (cpuPercent: number) => ({
    at: NOW,
    cpuPercent,
    cpuBusyPercent: cpuPercent,
    cpuStealPercent: null,
    cpuPressurePercent: null,
    cpuCount: 4,
    load: null,
    memoryUsedBytes: 1,
    memoryTotalBytes: 2,
    swapUsedBytes: null,
    swapTotalBytes: null,
    swapBytesPerSecond: null,
    diskUsedBytes: null,
    diskTotalBytes: null,
    netInBytesPerSecond: null,
    netOutBytesPerSecond: null,
    t3: null,
    agents: null,
    topCpu: null,
    topMemory: null,
    battery: null,
  });
  /** A connected MAC, and the SQL rows written and alarm writes since the last `usage()`. */
  async function connectedMac() {
    const harness = portal(true);
    const socket = machineSocket(MAC);
    harness.machineSockets.set(MAC, socket);
    const message = (body: unknown) =>
      harness.object.webSocketMessage(socket, JSON.stringify(body));
    await message({
      _tag: "hello",
      protocol: MACHINE_MAP_PROTOCOL,
      appliedRevision: 0,
      status: status({}),
      settings: { server: {}, client: {} },
    });
    const totalChanges = () => Number(harness.db.prepare("SELECT total_changes() AS n").get()?.n);
    let rows = totalChanges();
    // `setAlarm` and `deleteAlarm` each write a row.
    const alarmCalls = () =>
      harness.setAlarm.mock.calls.length + harness.deleteAlarm.mock.calls.length;
    let alarms = alarmCalls();
    const usage = () => {
      const now = { rows: totalChanges() - rows, alarms: alarmCalls() - alarms };
      rows = totalChanges();
      alarms = alarmCalls();
      return now;
    };
    return { ...harness, socket, message, usage };
  }
  const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

  it("writes presence only on a real change, and plans no alarm for a status", async () => {
    const { message, usage, send } = await connectedMac();
    send.mockClear();
    for (let i = 1; i <= 100; i++) {
      advance(5_000);
      await message({ _tag: "status", status: status({ cpuPercent: i, uptimeSeconds: i * 5 }) });
    }
    // One refresh of the last-seen time after 5 minutes.
    expect(usage()).toEqual({ rows: 1, alarms: 0 });
    // Pages still get every status.
    const presence = send.mock.calls
      .map(([text]) => JSON.parse(text))
      .filter((event) => event._tag === "presence");
    expect(presence).toHaveLength(100);
    expect(presence.at(-1).presence.status.cpuPercent).toBe(100);

    await message({ _tag: "status", status: status({ runningTurns: 1 }) });
    expect(usage()).toEqual({ rows: 1, alarms: 0 });
    for (let i = 0; i < 100; i++) await message({ _tag: "applied", revision: 0 });
    expect(usage()).toEqual({ rows: 0, alarms: 0 });
  });

  it("stores minute points in 10-minute blocks that survive hibernation and a close", async () => {
    vi.setSystemTime(new Date("2026-10-20T09:00:00.000Z"));
    const { message, usage, ctx, env, socket, machineSockets, db } = await connectedMac();
    for (let i = 0; i < 30; i++) {
      await message({ _tag: "resources", sample: sample(i) });
      advance(60_000);
    }
    // Two stored blocks: their minute points, the hour point and the latest sample.
    expect(usage()).toEqual({ rows: 6, alarms: 1 });

    // A woken object reads the unstored minutes from the socket.
    const woken = new MachineMapObject(ctx, env);
    const hour = await woken.resources(owner, MAC, "hour");
    if (!hour.ok) throw new Error(hour.error);
    expect(hour.value.cpu).toEqual(Array.from({ length: 30 }, (_, i) => i));

    machineSockets.delete(MAC);
    await woken.webSocketClose(socket, 1000, "Bye.");
    const restarted = new MachineMapObject(ctx, env);
    const stored = await restarted.resources(owner, MAC, "hour");
    if (!stored.ok) throw new Error(stored.error);
    expect(stored.value.cpu).toEqual(Array.from({ length: 30 }, (_, i) => i));

    // MM-1504: the close stored the exact last-seen time, so DOWN starts after 15 minutes.
    advance(15 * 60_000 - 1);
    await restarted.alarm();
    expect(db.prepare("SELECT machine_id FROM health_alerts WHERE active = 1").all()).toEqual([]);
    advance(1);
    await restarted.alarm();
    expect(db.prepare("SELECT machine_id FROM health_alerts WHERE active = 1").all()).toEqual([
      { machine_id: MAC },
    ]);
  });
});

/** MM-1210: an in-memory Cloudflare API with the Access apps, login methods and rate limit rules. */
function fakeCloudflare(
  options: {
    readonly wafStatus?: number;
    readonly rules?: ReadonlyArray<Record<string, unknown>>;
  } = {},
) {
  const apps = new Map<string, Record<string, unknown>>();
  const providers: Array<{ id: string; type: string }> = [];
  let ruleset: { id: string; rules: Array<Record<string, unknown>> } | null = options.rules
    ? { id: "ruleset", rules: [...options.rules] }
    : null;
  const calls: Array<string> = [];
  let next = 0;
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const refuse = (status: number) =>
    Response.json(
      { success: false, errors: [{ code: 10000, message: "no" }], result: null },
      { status },
    );
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname.replace("/client/v4", "");
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push(`${method} ${path}`);
    if (path === "/accounts/account/access/identity_providers") {
      if (method === "GET") return ok(providers);
      providers.push({ id: "otp", type: body.type });
      return ok({ id: "otp" });
    }
    if (path === "/accounts/account/access/apps") {
      if (method === "GET") return ok([...apps.values()]);
      const id = `app-${++next}`;
      apps.set(id, { ...body, id });
      return ok({ id });
    }
    const appId = path.split("/access/apps/")[1];
    if (appId !== undefined) {
      const app = apps.get(appId);
      if (!app) return refuse(404);
      if (method === "DELETE") apps.delete(appId);
      return ok(app);
    }
    if (path.startsWith("/zones/zone/rulesets")) {
      if (options.wafStatus) return refuse(options.wafStatus);
      if (path.endsWith("/entrypoint")) return ruleset ? ok(ruleset) : refuse(404);
      if (path === "/zones/zone/rulesets") {
        ruleset = { id: "ruleset", rules: body.rules.map((r: object) => ({ ...r, id: "rule" })) };
        return ok(ruleset);
      }
      if (method === "DELETE" && ruleset) ruleset.rules = [];
      if (method === "PATCH" && ruleset) ruleset.rules = [{ ...body, id: path.split("/").pop() }];
      return ok(ruleset);
    }
    throw new Error(`Unexpected Cloudflare call ${method} ${path}`);
  });
  return { apps, providers, calls, ruleset: () => ruleset };
}

describe("guest links (MM-1210)", () => {
  const PORTAL = "t3.example.com";
  const GUEST_ENV = { MACHINE_ZONE_ID: "zone", MACHINE_DOMAIN: "example.com" };
  /** Three machines on hosts that MM-1210 accepts under `example.com`. */
  const guestMap = () => {
    const map = threeMachines();
    return {
      ...map,
      machines: map.machines.map((m) => ({ ...m, hostname: `t3-${m.id}.example.com` })),
    };
  };
  const value = <T>(outcome: { ok: true; value: T } | { ok: false; error: string }): T => {
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  };
  const rules = {
    emails: [],
    emailDomains: ["@Example.com"],
    ipRanges: [],
    requireIpRanges: ["10.0.0.1"],
  };

  it("makes, repairs and removes the Access setup of each machine host", async () => {
    const { object, env } = portal(guestMap());
    Object.assign(env, GUEST_ENV);
    const cf = fakeCloudflare();

    const saved = value(await object.setGuestRules(owner, PORTAL, rules));
    expect(saved.rules).toEqual({
      ...rules,
      emailDomains: ["example.com"],
      requireIpRanges: ["10.0.0.1/32"],
    });
    expect(cf.apps.size).toBe(0);

    const on = value(await object.setGuestLinks(owner, PORTAL, MAC, true));
    expect(on.machines.find((m) => m.machineId === MAC)?.state).toEqual({ _tag: "ready" });
    expect(on.oneTimePin).toEqual({ _tag: "ready" });
    expect(on.rateLimit).toEqual({ _tag: "ready" });
    const guestApp = [...cf.apps.values()].find(
      (a) => a.name === "t3 guest links t3-mac.example.com",
    );
    expect(guestApp).toMatchObject({
      destinations: [
        { type: "public", uri: "t3-mac.example.com/guest" },
        { type: "public", uri: "t3-mac.example.com/api/guest/*" },
      ],
      session_duration: "24h",
      allowed_idps: ["otp"],
      // The required range applies only to the guests, never to the owner (MM-1211).
      policies: [
        { decision: "allow", include: [{ email: { email: owner.email } }], require: [] },
        {
          decision: "allow",
          include: [{ email_domain: { domain: "example.com" } }],
          require: [{ ip: { ip: "10.0.0.1/32" } }],
        },
      ],
    });
    expect(
      [...cf.apps.values()].find((a) => a.name === "t3 web build t3-mac.example.com"),
    ).toMatchObject({
      policies: [{ decision: "bypass", include: [{ everyone: {} }] }],
    });

    // A dashboard edit shows as drift, and Apply makes the app again.
    if (guestApp) guestApp.session_duration = "720h";
    const drifted = value(await object.guestLinksStatus(owner, PORTAL));
    expect(drifted.machines.find((m) => m.machineId === MAC)?.state._tag).toBe("needsApply");
    const repaired = value(await object.applyGuestLinks(owner, PORTAL));
    expect(repaired.machines.find((m) => m.machineId === MAC)?.state).toEqual({ _tag: "ready" });
    expect(cf.apps.size).toBe(2);

    // The portal never adds a twin of an app that it did not make.
    cf.apps.set("hand", {
      id: "hand",
      name: "T3 guest links (win)",
      destinations: [{ type: "public", uri: "t3-win.example.com/guest" }],
    });
    const blocked = value(await object.setGuestLinks(owner, PORTAL, WIN, true));
    expect(blocked.machines.find((m) => m.machineId === WIN)?.state._tag).toBe("blocked");
    expect(blocked.errors).toHaveLength(1);

    value(await object.setGuestLinks(owner, PORTAL, MAC, false));
    value(await object.setGuestLinks(owner, PORTAL, WIN, false));
    expect([...cf.apps.keys()]).toEqual(["hand"]);
    expect(cf.ruleset()?.rules).toEqual([]);
  });

  it("shows the manual rate limit step when the token lacks Zone WAF Edit", async () => {
    const { object, env } = portal(guestMap());
    Object.assign(env, GUEST_ENV);
    fakeCloudflare({ wafStatus: 403 });
    const status = value(await object.setGuestLinks(owner, PORTAL, VPS, true));
    expect(status.rateLimit).toEqual({ _tag: "cloudflareStep", step: "rateLimit" });
    expect(status.machines.find((m) => m.machineId === VPS)?.state).toEqual({ _tag: "ready" });
    expect(status.errors).toEqual([]);
  });

  it("removes the guest apps of a removed machine", async () => {
    const { object, env } = portal(guestMap());
    Object.assign(env, { ...GUEST_ENV, MACHINE_ACCESS_APP_ID: "m", CONNECT_ACCESS_APP_ID: "c" });
    const cf = fakeCloudflare();
    value(await object.setGuestLinks(owner, PORTAL, VPS, true));
    expect(cf.apps.size).toBe(2);
    vi.spyOn(CloudflareApi.prototype, "findServiceTokenId").mockResolvedValue(null);
    value(await object.removeMachine(owner, VPS));
    expect(cf.apps.size).toBe(0);
  });
  it("makes no apps on a host that a machine must not claim", async () => {
    const map = guestMap();
    const { object, env } = portal({
      ...map,
      machines: map.machines.map((m) =>
        m.id === WIN ? { ...m, hostname: "riffle.example.com" } : m,
      ),
    });
    Object.assign(env, GUEST_ENV);
    const cf = fakeCloudflare();
    const status = value(await object.setGuestLinks(owner, PORTAL, WIN, true));
    expect(status.machines.find((m) => m.machineId === WIN)?.state._tag).toBe("blocked");
    expect(cf.apps.size).toBe(0);
  });

  it("adopts the rate limit rule of the old manual steps", async () => {
    const { object, env } = portal(guestMap());
    Object.assign(env, GUEST_ENV);
    const manual = { ...GUEST_RATE_LIMIT_RULE, ref: undefined, id: "manual" };
    const cf = fakeCloudflare({ rules: [manual] });
    const status = value(await object.setGuestLinks(owner, PORTAL, VPS, true));
    expect(status.rateLimit).toEqual({ _tag: "ready" });
    expect(cf.calls.filter((c) => c.includes("/rulesets") && !c.startsWith("GET"))).toEqual([]);
    expect(cf.ruleset()?.rules).toMatchObject([{ id: "manual" }]);
  });
});
