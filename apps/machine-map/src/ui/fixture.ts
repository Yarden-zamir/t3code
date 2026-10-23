/**
 * Dev only: `?fixture=1` loads the map from `dev-fixture.local.json` instead of the portal, and
 * answers the API in memory. Writes never leave the page. Callers import this module only behind
 * `import.meta.env.DEV`, so a production build drops it.
 *
 * Copy a snapshot in first: `cp /tmp/map-redesign/map-snapshot.json apps/machine-map/dev-fixture.local.json`.
 * The file is a `machines_read` export with the fields that the portal adds left out, so this
 * module fills them. `&demo=1` adds an expiry, a proposal and a queued change, which the real
 * map may not have.
 */
import * as Schema from "effect/Schema";
import {
  MachineId,
  MapChange,
  PortalSnapshot,
  type MapProposal,
  type MapRevision,
} from "@t3tools/contracts/machineMap";

import type { WriteResult } from "../api.ts";
import { applyChanges } from "../rules/map.ts";
import { applyPresetChanges } from "../rules/presets.ts";
import type { PageEvent } from "./store.ts";

const FIXTURE_URL = "/dev-fixture.local.json";
const OWNER = { _tag: "owner", email: "owner@fixture.local", device: "fixture" } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`The fixture has no ${what}.`);
  return value;
};

const list = (value: unknown, what: string): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new Error(`The fixture has no ${what} list.`);
  return value;
};

/** A settings export with keys only becomes shared values of null, so every key shows. */
const settingValues = (value: unknown): Record<string, unknown> =>
  Array.isArray(value)
    ? Object.fromEntries(value.map((key) => [String(key), null]))
    : record(value, "settings scope");

/** Fills what `machines_read` leaves out, then decodes, so a bad file fails here and loudly. */
function toSnapshot(raw: unknown): PortalSnapshot {
  const file = record(raw, "top level");
  const map = record(file.map, "map");
  const revision = Number(map.revision);
  const settings = record(map.settings, "settings");
  const shared = record(settings.shared, "shared settings");
  const presence = record(file.presence ?? {}, "presence");
  return Schema.decodeUnknownSync(PortalSnapshot)({
    placeUnits: "pixels",
    map: {
      ...map,
      machines: list(map.machines, "machine").map((machine) => ({
        tokenClientId: `fixture-${String(record(machine, "machine").id)}`,
        ...record(machine, "machine"),
      })),
      settings: {
        shared: { server: settingValues(shared.server), client: settingValues(shared.client) },
        overrides: isRecord(settings.overrides) ? settings.overrides : {},
      },
    },
    presence: Object.fromEntries(
      Object.entries(presence).map(([id, value]) => {
        const entry = record(value, "presence entry");
        const status = isRecord(entry.status) ? entry.status : null;
        return [
          id,
          {
            online: entry.online === true,
            lastSeenAt: entry.lastSeenAt ?? null,
            appliedRevision: entry.appliedRevision ?? revision,
            status: status && {
              build: "release",
              scheduledTasks: 0,
              updateWaiting: null,
              commands: ["testArrow", "restartServer", "stopAllAgents"],
              ...status,
              clients: list(status.clients ?? [], "client session").map((session, index) => ({
                sessionId: `${id}-${index}`,
                subject: "owner",
                browser: null,
                ...record(session, "client session"),
              })),
            },
          },
        ];
      }),
    ),
    reportedSettings: {},
    commands: [],
    history: [],
    proposals: [],
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * `&demo=1`: one temporary arrow that the offline Windows did not apply yet, one temporary client
 * arrow and one waiting proposal. These states exist in the portal but not always in a snapshot.
 */
function withDemoStates(snapshot: PortalSnapshot): PortalSnapshot {
  const map = snapshot.map;
  const id = (name: string) => map.machines.find((m) => m.name === name)?.id;
  const vps = id("VPS");
  const windows = id("Windows");
  const oracle = id("Oracle-VPS");
  const client = map.clients[0];
  if (!vps || !windows || !oracle)
    throw new Error("The demo states need VPS, Windows and Oracle-VPS.");
  const now = Date.now();
  const changes: Array<MapChange> = [
    {
      _tag: "setArrow",
      arrow: {
        from: vps,
        to: windows,
        level: "standard",
        agentTools: false,
        exec: false,
        expiresAt: iso(now + 2 * 3_600_000),
        revertLevel: "read",
      },
    },
    ...(client
      ? [
          {
            _tag: "setClientArrow",
            arrow: {
              client: client.id,
              to: windows,
              level: "standard",
              expiresAt: iso(now + 20 * 3_600_000),
              revertLevel: "none",
            },
          } as const,
        ]
      : []),
  ];
  const applied = applyChanges(map, changes);
  const next = map.revision + 1;
  const demoRevision: MapRevision = {
    revision: next,
    at: iso(now - 5 * 60_000),
    actor: OWNER,
    summary: "VPS uses Windows: Standard for 2 hours (demo)",
    changes,
    inverse: applied.inverse,
  };
  const proposal: MapProposal = {
    id: "demo-proposal",
    at: iso(now - 12 * 60_000),
    expiresAt: iso(now + 23 * 3_600_000),
    actor: { _tag: "agent", machineId: oracle, threadId: null, threadTitle: "Deploy the API" },
    summary: "Oracle-VPS uses VPS: Standard with agent tools (demo)",
    changes: [
      {
        _tag: "setArrow",
        arrow: {
          from: oracle,
          to: vps,
          level: "standard",
          agentTools: true,
          exec: false,
          expiresAt: null,
          revertLevel: null,
        },
      },
    ],
    reason: "self-escalation",
  };
  const presence = Object.fromEntries(
    Object.entries(snapshot.presence).map(([machineId, entry]) => [
      machineId,
      // Windows is offline in the snapshot, so the demo change waits for it.
      { ...entry, appliedRevision: machineId === windows ? map.revision : next },
    ]),
  );
  return {
    ...snapshot,
    map: { ...applied.map, revision: next },
    presence,
    history: [demoRevision, ...snapshot.history],
    proposals: [proposal, ...snapshot.proposals],
  };
}

type Listener = (event: PageEvent) => void;

let current: PortalSnapshot | null = null;
const listeners = new Set<Listener>();
const emit = (event: PageEvent) => listeners.forEach((listener) => listener(event));

/** Applies changes as a new revision in memory, like the portal does for an owner write. */
function commit(summary: string, changes: ReadonlyArray<MapChange>): WriteResult {
  if (!current) throw new Error("The fixture is not loaded yet.");
  const applied = applyChanges(current.map, changes);
  const revision: MapRevision = {
    revision: current.map.revision + 1,
    at: new Date().toISOString(),
    actor: OWNER,
    summary,
    changes,
    inverse: applied.inverse,
  };
  const map = { ...applied.map, revision: revision.revision };
  // Online machines apply at once, so only offline ones show the change as queued.
  const presence = Object.fromEntries(
    Object.entries(current.presence).map(([id, entry]) => [
      id,
      entry.online ? { ...entry, appliedRevision: revision.revision } : entry,
    ]),
  );
  current = { ...current, map, presence, history: [revision, ...current.history] };
  emit({ _tag: "revision", revision, map });
  for (const [id, entry] of Object.entries(presence))
    emit({ _tag: "presence", machineId: MachineId.make(id), presence: entry });
  return { _tag: "applied", revision: revision.revision };
}

const ChangesBody = Schema.Struct({
  summary: Schema.String,
  changes: Schema.Array(Schema.Unknown),
});
const decodeChanges = Schema.decodeUnknownSync(ChangesBody);
const decodeMapChanges = Schema.decodeUnknownSync(Schema.Array(MapChange));

/** `/api/proposals/<id>/approve` gives `["<id>", "approve"]`. */
const pathTail = (path: string, prefix: string): ReadonlyArray<string> | null =>
  path.startsWith(prefix) ? path.slice(prefix.length).split("/").map(decodeURIComponent) : null;

/** The writes that the redesigns use. Every other path says that it needs the live portal. */
export async function fixtureApi(method: string, path: string, body: unknown): Promise<unknown> {
  if (!current) throw new Error("The fixture is not loaded yet.");
  if (method === "POST" && (path === "/api/changes" || path === "/api/grant/changes")) {
    const request = decodeChanges(body);
    return commit(request.summary, decodeMapChanges(request.changes));
  }
  if (method === "POST" && path === "/api/undo" && isRecord(body)) {
    const target = current.history.find((r) => r.revision === body.revision);
    if (!target) throw new Error("Fixture mode undoes only the changes of this page.");
    return commit(`Undo rev ${target.revision}`, target.inverse);
  }
  const [id, verdict] = pathTail(path, "/api/proposals/") ?? [];
  if (method === "POST" && id && (verdict === "approve" || verdict === "reject")) {
    const found = current.proposals.find((p) => p.id === id);
    if (!found) throw new Error("The proposal is gone.");
    current = { ...current, proposals: current.proposals.filter((p) => p.id !== id) };
    emit({ _tag: "proposals", proposals: current.proposals });
    return verdict === "approve" ? commit(found.summary, found.changes) : { rejected: id };
  }
  const [name, presetAction] = pathTail(path, "/api/presets/") ?? [];
  if (method === "POST" && name && presetAction === "apply") {
    const found = current.map.presets.find((p) => p.name === name);
    if (!found) throw new Error(`No preset ${name}.`);
    return commit(`Applied preset ${name}`, applyPresetChanges(current.map, found));
  }
  throw new Error(`Fixture mode: ${method} ${path} needs the live portal. Nothing was sent.`);
}

/** Loads the fixture once and sends its snapshot, then each in-memory change. */
export async function subscribeFixture(listener: Listener): Promise<() => void> {
  if (!current) {
    const response = await fetch(FIXTURE_URL, { cache: "no-store" });
    if (!response.ok)
      throw new Error(
        `No ${FIXTURE_URL}. Copy a snapshot to apps/machine-map/dev-fixture.local.json.`,
      );
    const snapshot = toSnapshot(await response.json());
    current = new URLSearchParams(location.search).has("demo")
      ? withDemoStates(snapshot)
      : snapshot;
  }
  listeners.add(listener);
  listener({ _tag: "snapshot", snapshot: current });
  return () => listeners.delete(listener);
}
