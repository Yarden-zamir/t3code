/**
 * Dev only: `?fixture=1` loads the map from `dev-fixture.local.json` (a `machines_read` export) and
 * answers the API in memory, so writes never leave the page. Import it only behind
 * `import.meta.env.DEV`. Git ignores the file, because a real export holds hostnames and emails.
 * `&demo=1` adds an expiry, a proposal and a queued change that the real map may not have.
 */
import * as Schema from "effect/Schema";
import {
  MachineId,
  MapChange,
  PortalSnapshot,
  type MapProposal,
  type MapRevision,
} from "@t3tools/contracts/machineMap";

import type { GuestLinksStatus, GuestRules, PauseView, WriteResult } from "../api.ts";
import { EMPTY_GUEST_RULES, GUEST_SETTING, guestLinksOn } from "../guestLinks.ts";
import { applyChanges, findArrow, findClientArrow } from "../rules/map.ts";
import {
  applyPresetChanges,
  PAUSE_SUMMARY,
  pauseChanges,
  RESUME_SUMMARY,
} from "../rules/presets.ts";
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

const decodeSnapshot = Schema.decodeUnknownSync(PortalSnapshot);

/** Fills what `machines_read` leaves out, then decodes, so a bad file fails here and loudly. */
function toSnapshot(raw: unknown): PortalSnapshot {
  const file = record(raw, "top level");
  const map = record(file.map, "map");
  const revision = Number(map.revision);
  const settings = record(map.settings, "settings");
  const shared = record(settings.shared, "shared settings");
  const presence = record(file.presence ?? {}, "presence");
  return decodeSnapshot({
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
 * `&demo=1`: one temporary arrow that an offline machine did not apply yet, one temporary client
 * arrow and one waiting proposal. These states exist in the portal but not always in a snapshot.
 */
function withDemoStates(snapshot: PortalSnapshot): PortalSnapshot {
  const map = snapshot.map;
  const offline =
    map.machines.find((m) => snapshot.presence[m.id]?.online === false) ?? map.machines[2];
  const [source, asker] = map.machines.filter((m) => m.id !== offline?.id);
  const client = map.clients[0];
  if (!offline || !source || !asker) throw new Error("The demo states need three machines.");
  const sourceId = source.id;
  const offlineId = offline.id;
  const askerId = asker.id;
  const now = Date.now();
  const changes: Array<MapChange> = [
    {
      _tag: "setArrow",
      arrow: {
        from: sourceId,
        to: offlineId,
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
              to: offlineId,
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
    summary: `${source.name} uses ${offline.name}: Standard for 2 hours (demo)`,
    changes,
    inverse: applied.inverse,
  };
  const proposal: MapProposal = {
    id: "demo-proposal",
    at: iso(now - 12 * 60_000),
    expiresAt: iso(now + 23 * 3_600_000),
    actor: { _tag: "agent", machineId: askerId, threadId: null, threadTitle: "Deploy the API" },
    summary: `${asker.name} uses ${source.name}: Standard with agent tools (demo)`,
    changes: [
      {
        _tag: "setArrow",
        arrow: {
          from: askerId,
          to: sourceId,
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
      // The offline machine did not apply the demo change, so it waits for it.
      { ...entry, appliedRevision: machineId === offlineId ? map.revision : next },
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
/** MM-710: the arrows from before the pause, so Resume returns them. */
let paused: { readonly view: PauseView; readonly before: PortalSnapshot["map"] } | null = null;
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

let guestRules: GuestRules = EMPTY_GUEST_RULES;

/**
 * MM-1210: a guest links state without Cloudflare. Machines with guest links on are ready, and the
 * rate limit shows its manual step, so the page shows each kind of row.
 */
function fixtureGuests(snapshot: PortalSnapshot): GuestLinksStatus {
  const machines = snapshot.map.machines.map((m) => {
    const enabled = guestLinksOn(
      snapshot.map,
      snapshot.reportedSettings[m.id] ?? { server: {}, client: {} },
      m.id,
    );
    return {
      machineId: m.id,
      hostname: m.hostname,
      enabled,
      state: !enabled
        ? ({ _tag: "off" } as const)
        : m.hostname === null
          ? ({ _tag: "noHostname" } as const)
          : ({ _tag: "ready" } as const),
    };
  });
  return {
    rules: guestRules,
    problem: null,
    oneTimePin: { _tag: "ready" },
    rateLimit: { _tag: "cloudflareStep", step: "rateLimit" },
    machines,
    errors: [],
  };
}

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
  if (method === "POST" && path === "/api/pause") {
    if (paused) throw new Error("Already paused.");
    const before = current.map;
    const view: PauseView = {
      pausedAt: new Date().toISOString(),
      by: OWNER,
      revision: before.revision + 1,
      cut: before.arrows.flatMap((a) =>
        a.level === "none" ? [] : [{ from: a.from, to: a.to, level: a.level }],
      ),
      cutClients: before.clientArrows.flatMap((a) =>
        a.level === "none" ? [] : [{ client: a.client, to: a.to, level: a.level }],
      ),
    };
    commit(PAUSE_SUMMARY, pauseChanges(before));
    paused = { view, before };
    emit({ _tag: "pause", pause: view });
    return {
      pause: { pausedAt: view.pausedAt, by: view.by, revision: view.revision },
      stopCommands: 0,
    };
  }
  if (method === "POST" && path === "/api/resume") {
    if (!paused) throw new Error("Nothing is paused.");
    const { before } = paused;
    const changes: Array<MapChange> = [
      ...paused.view.cut.map((cut): MapChange => ({
        _tag: "setArrow",
        arrow: findArrow(before, cut.from, cut.to),
      })),
      ...paused.view.cutClients.map((cut): MapChange => ({
        _tag: "setClientArrow",
        arrow: findClientArrow(before, cut.client, cut.to),
      })),
      ...before.machines.flatMap((m): Array<MapChange> =>
        m.mapRole === "none" ? [] : [{ _tag: "putMachine", machine: m }],
      ),
    ];
    paused = null;
    const result = commit(RESUME_SUMMARY, changes);
    emit({ _tag: "pause", pause: null });
    return result._tag === "applied" ? { revision: result.revision } : { revision: null };
  }
  if (path === "/api/guests" || path === "/api/guests/apply") return fixtureGuests(current);
  if (method === "POST" && path === "/api/guests/rules" && isRecord(body) && isRecord(body.rules)) {
    const rules = body.rules;
    const strings = (key: keyof GuestRules) =>
      list(rules[key], key).filter((v): v is string => typeof v === "string");
    guestRules = {
      emails: strings("emails"),
      emailDomains: strings("emailDomains"),
      ipRanges: strings("ipRanges"),
      requireIpRanges: strings("requireIpRanges"),
    };
    return fixtureGuests(current);
  }
  const [guestMachine, guestAction] = pathTail(path, "/api/machines/") ?? [];
  if (method === "POST" && guestMachine && guestAction === "guest-links" && isRecord(body)) {
    commit(`Guest links ${body.enabled === true ? "on" : "off"}`, [
      {
        _tag: "setSetting",
        machineId: MachineId.make(guestMachine),
        scope: "server",
        key: GUEST_SETTING,
        present: true,
        value: body.enabled === true,
      },
    ]);
    return fixtureGuests(current);
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
