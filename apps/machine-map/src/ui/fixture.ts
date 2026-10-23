/**
 * The in-memory portal of fixture mode (`devMode.ts`). It serves the snapshot of
 * `dev/fixture.json` and answers the writes of the page with the same rules as the portal:
 * changes, undo, proposals, presets, pause and resume. Nothing leaves the page.
 */
import * as Schema from "effect/Schema";
import {
  CommandDelivery,
  MachineCommandInput,
  MachineId,
  PortalSnapshot,
  type MachineCommand,
  type MapActor,
  type MapChange,
  type MapProposal,
  type MapRevision,
} from "@t3tools/contracts/machineMap";

import type { PauseView, WriteResult } from "../api.ts";
import { arrowChange } from "../rules/access.ts";
import { applyChanges, undoChanges } from "../rules/map.ts";
import { pauseChanges } from "../rules/presets.ts";
import { FIXTURE_DEMO } from "./devMode.ts";
import { INITIAL_STATE, reduce, type PageEvent, type PortalState } from "./store.ts";

const decodeSnapshot = Schema.decodeUnknownSync(PortalSnapshot);
const decodeCommandBody = Schema.decodeUnknownSync(
  Schema.Struct({ machineId: MachineId, input: MachineCommandInput, delivery: CommandDelivery }),
);

const OWNER: MapActor = { _tag: "owner", email: "owner@fixture.local", device: "Fixture page" };

type Listener = (state: PortalState) => void;

let state: PortalState = INITIAL_STATE;
const listeners = new Set<Listener>();
let loading: Promise<void> | null = null;

const emit = (event: PageEvent) => {
  state = reduce(state, event);
  for (const listener of listeners) listener(state);
};

const snapshot = () => {
  if (!state.snapshot) throw new Error("Fixture mode: the fixture did not load yet.");
  return state.snapshot;
};

/** One revision from changes, like the portal makes it. */
function commit(summary: string, changes: ReadonlyArray<MapChange>, actor = OWNER): WriteResult {
  const current = snapshot();
  const applied = applyChanges(current.map, changes);
  const revision = current.map.revision + 1;
  const record: MapRevision = {
    revision,
    at: new Date().toISOString(),
    actor,
    summary,
    changes,
    inverse: applied.inverse,
  };
  emit({ _tag: "revision", revision: record, map: { ...applied.map, revision } });
  // Every machine applies at once in the fixture, so nothing shows as queued.
  for (const [id, presence] of Object.entries(snapshot().presence))
    emit({
      _tag: "presence",
      machineId: id as never,
      presence: { ...presence, appliedRevision: revision },
    });
  return { _tag: "applied", revision };
}

/** MM-804: the demo proposal. An agent on VPS asks for standard access with agent tools. */
function demoProposal(now: number): MapProposal {
  const current = snapshot();
  const vps = current.map.machines.find((m) => m.name === "VPS");
  const oracle = current.map.machines.find((m) => m.name === "Oracle-VPS");
  if (!vps || !oracle) throw new Error("Fixture demo needs the machines VPS and Oracle-VPS.");
  return {
    id: "fixture-proposal-1",
    at: new Date(now - 20 * 60_000).toISOString(),
    expiresAt: new Date(now + 23 * 3_600_000).toISOString(),
    actor: {
      _tag: "agent",
      machineId: vps.id,
      threadId: null,
      threadTitle: "Deploy the digest site",
    },
    summary: "VPS uses Oracle-VPS: Standard, with agent tools",
    changes: [
      arrowChange(current.map, {
        from: vps.id,
        to: oracle.id,
        level: "standard",
        agentTools: true,
        expiresAt: null,
      }),
    ],
    reason: "owner-only",
  };
}

/** MM-304: the demo temporary arrow. Windows gets admin on Mac for one hour. */
function demoExpiry(now: number) {
  const current = snapshot();
  const windows = current.map.machines.find((m) => m.name === "Windows");
  const mac = current.map.machines.find((m) => m.name === "Mac");
  if (!windows || !mac) throw new Error("Fixture demo needs the machines Windows and Mac.");
  commit("Windows uses Mac: Admin until 1 hour from now", [
    arrowChange(current.map, {
      from: windows.id,
      to: mac.id,
      level: "admin",
      expiresAt: new Date(now + 3_600_000).toISOString(),
    }),
  ]);
}

async function load(): Promise<void> {
  const response = await fetch("/dev-fixture.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`The fixture did not load: ${response.status}.`);
  emit({ _tag: "snapshot", snapshot: decodeSnapshot(await response.json()) });
  if (FIXTURE_DEMO) {
    const now = Date.now();
    demoExpiry(now);
    emit({ _tag: "proposals", proposals: [demoProposal(now)] });
  }
}

/** Gives the listener the state now and on every change. */
export function subscribeFixture(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  loading ??= load();
  loading.catch((error: unknown) => console.error("Fixture mode", error));
  return () => {
    listeners.delete(listener);
  };
}

const idOf = (path: string, prefix: string, suffix: string) =>
  decodeURIComponent(path.slice(prefix.length, path.length - suffix.length));

const isChanges = (body: unknown): body is { summary: string; changes: ReadonlyArray<MapChange> } =>
  typeof body === "object" && body !== null && "summary" in body && "changes" in body;

/** Answers the API calls of the page in memory. Unknown paths say that the fixture is read only. */
export async function fixtureApi(method: string, path: string, body: unknown): Promise<unknown> {
  await (loading ?? load());
  const current = snapshot();
  if (method === "POST" && (path === "/api/changes" || path === "/api/grant/changes")) {
    if (!isChanges(body)) throw new Error("Fixture mode: bad changes body.");
    return commit(body.summary, body.changes);
  }
  if (method === "POST" && path === "/api/undo") {
    const wanted =
      typeof body === "object" && body !== null && "revision" in body ? body.revision : null;
    const revision = current.history.find((r) => r.revision === wanted);
    if (!revision) throw new Error(`Fixture mode: revision ${String(wanted)} is not loaded.`);
    return commit(`Undo rev ${revision.revision}`, undoChanges(current.map, revision.inverse));
  }
  if (method === "POST" && path.startsWith("/api/proposals/")) {
    const approve = path.endsWith("/approve");
    const id = idOf(path, "/api/proposals/", approve ? "/approve" : "/reject");
    const proposal = current.proposals.find((p) => p.id === id);
    if (!proposal) throw new Error("Fixture mode: that proposal is gone.");
    emit({ _tag: "proposals", proposals: current.proposals.filter((p) => p.id !== id) });
    return approve ? commit(proposal.summary, proposal.changes, proposal.actor) : { ok: true };
  }
  if (method === "POST" && path.startsWith("/api/presets/") && path.endsWith("/apply")) {
    const name = idOf(path, "/api/presets/", "/apply");
    const preset = current.map.presets.find((p) => p.name === name);
    if (!preset) throw new Error("Fixture mode: no such preset.");
    return commit(
      `Applied preset ${name}`,
      preset.arrows.map((arrow) => ({ _tag: "setArrow", arrow })),
    );
  }
  if (method === "POST" && path === "/api/pause") {
    const cut = current.map.arrows.filter((a) => a.level !== "none");
    const cutClients = current.map.clientArrows.filter((a) => a.level !== "none");
    const changes = pauseChanges(current.map);
    const result = changes.length > 0 ? commit("Emergency pause", changes) : null;
    const pause: PauseView = {
      pausedAt: new Date().toISOString(),
      by: OWNER,
      revision: result?._tag === "applied" ? result.revision : null,
      cut: cut.map(({ from, to, level }) => ({ from, to, level })),
      cutClients: cutClients.map(({ client, to, level }) => ({ client, to, level })),
    };
    emit({ _tag: "pause", pause });
    return { pause, stopCommands: current.map.machines.length };
  }
  if (method === "POST" && path === "/api/resume") {
    const pause = state.pause;
    if (!pause) return { revision: null };
    const revision = current.history.find((r) => r.revision === pause.revision);
    emit({ _tag: "pause", pause: null });
    if (!revision) return { revision: null };
    const result = commit("Resume", undoChanges(current.map, revision.inverse));
    return { revision: result._tag === "applied" ? result.revision : null };
  }
  if (method === "POST" && path === "/api/commands") {
    const input = decodeCommandBody(body);
    const now = new Date().toISOString();
    const command: MachineCommand = {
      id: `fixture-command-${Date.now()}`,
      machineId: input.machineId,
      input: input.input,
      delivery: input.delivery,
      actor: OWNER,
      status: "delivered",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      result: null,
      error: null,
    };
    emit({ _tag: "command", command });
    return command;
  }
  if (method === "GET" && path.startsWith("/api/history")) return { revisions: [] };
  throw new Error(`Fixture mode is read only: ${method} ${path} does nothing here.`);
}
