// @effect-diagnostics nodeBuiltinImport:off - A card id is a sync hash of the thread id.
/**
 * Fork: how the kitshn grant tables (K-706) decide access to T3. Pure functions, so the auth
 * hooks, the provider and their tests share one rule set. kitshn matches the same way in
 * `packages/edge/src/core/visitor.ts`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthRelayWriteScope,
  MACHINE_LEVEL_SCOPES,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";

import type { Grant, GrantRule, GrantTables } from "./kitshnProviderProtocol.ts";

/** K-713: each kind with its levels, named by the kitshn level that they stand for. */
export const KINDS = [
  {
    id: "t3.app",
    name: "T3 app",
    levels: { view: "read", use: "standard", control: "admin" },
    // K-719 (cutover): the owner is never locked out of the app or the agent tools.
    ownerControl: true,
  },
  { id: "t3.thread", name: "T3 thread", levels: { view: "view", use: "send" } },
  {
    id: "t3.agents",
    name: "T3 agents",
    levels: { use: "use", control: "exec" },
    ownerControl: true,
  },
] as const;
type KindEntry = (typeof KINDS)[number];
export type Kind = KindEntry["id"];
type LevelsOf<K extends Kind> = Extract<KindEntry, { readonly id: K }>["levels"];
export type LevelOf<K extends Kind> = LevelsOf<K>[keyof LevelsOf<K>];

/** The levels of a kind, lowest first. */
const ranked = <K extends Kind>(kind: K): ReadonlyArray<LevelOf<K>> => {
  const levels: Partial<Record<"view" | "use" | "control", string>> = KINDS.find(
    (entry) => entry.id === kind,
  )!.levels;
  return (["view", "use", "control"] as const).flatMap((key) => {
    const level = levels[key];
    return level === undefined ? [] : [level as LevelOf<K>];
  });
};

export const APP_RESOURCE_ID = "app";
export const AGENTS_RESOURCE_ID = "agents";

/**
 * The card id of a shared thread. A thread id can hold characters that a kitshn id refuses
 * (K-704: `a-z A-Z 0-9 . _ -`, at most 64), so the id is a hash of it.
 */
export const threadResourceId = (threadId: string) =>
  `th-${NodeCrypto.createHash("sha256").update(threadId).digest("base64url").slice(0, 32)}`;

/**
 * kitshn sees a saved table as good for this long without contact. After that every Access JWT
 * request is refused until a fresh table arrives, so a grant that kitshn removed while T3 could
 * not hear it ends at the latest then. Revisit when kitshn sends a signed table with its own expiry.
 */
export const SAVED_GRANTS_LIFETIME = Duration.hours(24);

/** What a verified Access JWT says about its visitor (K-706 rule 1). */
export interface AccessVisitor {
  /** Lowercase, so `email` and `domain` rules compare in lowercase. */
  readonly email: string | null;
  /** The `common_name` of a service token. `device` and `machine` rules match it. */
  readonly clientId: string | null;
  /** The `Cf-Connecting-IP` header. The socket address is always loopback behind the tunnel. */
  readonly ip: string | null;
}

/** The saved tables and when kitshn last answered, so the 24-hour limit survives a restart. */
export interface GrantState {
  readonly tables: GrantTables;
  readonly lastContactAt: number | null;
}

const ipInRange = (ip: string, range: string): boolean => {
  const slash = range.indexOf("/");
  if (slash <= 0) return false;
  const base = range.slice(0, slash);
  const prefix = Number(range.slice(slash + 1));
  const family = NodeNet.isIP(base);
  if (family === 0 || family !== NodeNet.isIP(ip) || !Number.isInteger(prefix)) return false;
  const type = family === 6 ? "ipv6" : "ipv4";
  try {
    const list = new NodeNet.BlockList();
    list.addSubnet(base, prefix, type);
    return list.check(ip, type);
  } catch {
    return false;
  }
};

const ruleMatches = (rule: GrantRule, visitor: AccessVisitor): boolean => {
  if ("email" in rule) return visitor.email !== null && visitor.email === rule.email.toLowerCase();
  if ("domain" in rule) {
    return visitor.email !== null && visitor.email.endsWith(`@${rule.domain.toLowerCase()}`);
  }
  if ("ip" in rule) return visitor.ip !== null && ipInRange(visitor.ip, rule.ip);
  if ("device" in rule)
    return visitor.clientId !== null && visitor.clientId === rule.device.clientId;
  if ("machine" in rule) {
    return visitor.clientId !== null && visitor.clientId === rule.machine.clientId;
  }
  if ("everyone" in rule) return true;
  return false;
};

/** K-203: an empty circle matches nobody. `needsPasskey` is checked by Access, not here. */
const circleMatches = (circle: Grant["circle"], visitor: AccessVisitor) =>
  circle.rules.length > 0 &&
  (circle.match === "all"
    ? circle.rules.every((rule) => ruleMatches(rule, visitor))
    : circle.rules.some((rule) => ruleMatches(rule, visitor)));

const isFresh = (state: GrantState, nowMs: number) =>
  state.lastContactAt !== null &&
  nowMs - state.lastContactAt < Duration.toMillis(SAVED_GRANTS_LIFETIME);

/**
 * K-706: the highest level of the grants of a resource that match the visitor now, or null: no
 * grant, an ended grant or a stale table means no access. A level that the kind does not have
 * counts as no grant.
 */
export const levelFor = <K extends Kind>(
  state: GrantState,
  kind: K,
  resourceId: string,
  visitor: AccessVisitor,
  nowMs: number,
): LevelOf<K> | null => {
  if (!isFresh(state, nowMs)) return null;
  const levels = ranked(kind);
  let best = -1;
  for (const grant of state.tables[resourceId] ?? []) {
    if (grant.endsAt !== null && grant.endsAt <= nowMs) continue;
    const rank = levels.indexOf(grant.level as LevelOf<K>);
    if (rank > best && circleMatches(grant.circle, visitor)) best = rank;
  }
  return best < 0 ? null : levels[best]!;
};

/** True when `level` is at least `needed` in the order of its kind. */
export const atLeast = <K extends Kind>(kind: K, level: LevelOf<K> | null, needed: LevelOf<K>) =>
  level !== null && ranked(kind).indexOf(level) >= ranked(kind).indexOf(needed);

/**
 * The scopes of a `t3.app` level: the machine map scopes of that level. As for a browser client
 * of the map (MM-922), a session that the Access cookie gets never mints pairing links or relay
 * grants that outlive the grant.
 */
export const appLevelScopes = (level: LevelOf<"t3.app">): ReadonlyArray<AuthEnvironmentScope> =>
  MACHINE_LEVEL_SCOPES[level].filter(
    (scope) => scope !== AuthAccessWriteScope && scope !== AuthRelayWriteScope,
  );

/** True when a session holds no scope above the `t3.app` level of its visitor now. */
export const sessionAllowed = (
  state: GrantState,
  session: { readonly scopes: ReadonlyArray<AuthEnvironmentScope> },
  visitor: AccessVisitor,
  nowMs: number,
) => {
  const level = levelFor(state, "t3.app", APP_RESOURCE_ID, visitor, nowMs);
  if (level === null) return false;
  const allowed = new Set(appLevelScopes(level));
  return session.scopes.every((scope) => allowed.has(scope));
};

/** The next time that access changes without a new table: an `endsAt` or the 24-hour limit. */
export const nextChangeAt = (state: GrantState, nowMs: number): number | null => {
  if (!isFresh(state, nowMs)) return null;
  let next = state.lastContactAt! + Duration.toMillis(SAVED_GRANTS_LIFETIME);
  for (const grants of Object.values(state.tables)) {
    for (const grant of grants) {
      if (grant.endsAt !== null && grant.endsAt > nowMs && grant.endsAt < next) next = grant.endsAt;
    }
  }
  return next;
};
