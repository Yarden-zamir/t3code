import * as NodeSqlite from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { MachineMapDocument } from "@t3tools/contracts/machineMap";

import { CloudflareApi } from "./cloudflare.ts";
import type { Env } from "./env.ts";
import { MachineMapObject, type OwnerContext } from "./MachineMapObject.ts";
import { emptyMap } from "./rules/map.ts";
import { MAC, threeMachines } from "./rules/testMap.ts";
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

function portal(machines = false) {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO meta VALUES ('map', ?)").run(
    JSON.stringify(machines ? threeMachines() : emptyMap()),
  );
  db.prepare("INSERT INTO meta VALUES ('absolute_places', ?)").run(NOW);
  const send = vi.fn();
  const setAlarm = vi.fn(async (_at: number) => {});
  const ctx = {
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: (tag: string) => (tag === "page" ? [{ send }] : []),
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
      deleteAlarm: vi.fn(async () => {}),
    },
  } as unknown as DurableObjectState;
  const env = {
    SECRET_KEY: btoa("a".repeat(32)),
    ACCOUNT_ID: "account",
    OWNER_EMAILS: owner.email,
    TEAM_DOMAIN: "team.cloudflareaccess.com",
    DEV_FAKE_ACCESS: "1",
    ...(machines ? { CF_API_TOKEN: "test-only" } : {}),
  } as Env;
  return { db, ctx, env, object: new MachineMapObject(ctx, env), send, setAlarm };
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

const readMap = (db: NodeSqlite.DatabaseSync) =>
  Schema.decodeUnknownSync(MachineMapDocument)(
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
