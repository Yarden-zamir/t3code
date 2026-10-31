// @effect-diagnostics nodeBuiltinImport:off - A card id is a sync hash of the thread id.
/**
 * Fork: the T3 kinds of kitshn (K-713) and what their levels give. The daemon decides who holds
 * which level (`check`, K-721); these pure functions turn a level into T3 access.
 */
import * as NodeCrypto from "node:crypto";

import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthRelayWriteScope,
  MACHINE_LEVEL_SCOPES,
} from "@t3tools/contracts";

/** K-713: each kind with its levels, named by the kitshn level that they stand for. */
export const KINDS = [
  {
    id: "t3.app",
    name: "T3 app",
    levels: { view: "read", use: "standard", control: "admin" },
    // K-719: the owner is never locked out of the app.
    ownerControl: true,
  },
  { id: "t3.thread", name: "T3 thread", levels: { view: "view", use: "send" } },
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

/**
 * The card id of a shared thread. A thread id can hold characters that a kitshn id refuses
 * (K-704: `a-z A-Z 0-9 . _ -`, at most 64), so the id is a hash of it.
 */
export const threadResourceId = (threadId: string) =>
  `th-${NodeCrypto.createHash("sha256").update(threadId).digest("base64url").slice(0, 32)}`;

/** The level that `check` gave for a resource, or null: a level that the kind lacks is none. */
export const levelFor = <K extends Kind>(
  kind: K,
  resourceId: string,
  levels: Readonly<Record<string, string>>,
): LevelOf<K> | null => {
  const level = levels[resourceId];
  return level !== undefined && (ranked(kind) as ReadonlyArray<string>).includes(level)
    ? (level as LevelOf<K>)
    : null;
};

/**
 * The scopes of a `t3.app` level: the machine map scopes of that level. As for a browser client
 * of the map (MM-922), a session that the Access cookie gets never mints pairing links or relay
 * grants that outlive the grant.
 */
export const appLevelScopes = (level: LevelOf<"t3.app">): ReadonlyArray<AuthEnvironmentScope> =>
  MACHINE_LEVEL_SCOPES[level].filter(
    (scope) => scope !== AuthAccessWriteScope && scope !== AuthRelayWriteScope,
  );

/** True when a session holds no scope above the `t3.app` level in `levels`. */
export const sessionAllowed = (
  session: { readonly scopes: ReadonlyArray<AuthEnvironmentScope> },
  levels: Readonly<Record<string, string>>,
) => {
  const level = levelFor("t3.app", APP_RESOURCE_ID, levels);
  if (level === null) return false;
  const allowed = new Set(appLevelScopes(level));
  return session.scopes.every((scope) => allowed.has(scope));
};

/**
 * MM-1311: the `https://` origins of the app cards in this machine's reach (K-1609). Their pages
 * are trusted like the explicit list while the link holds. Only a bare host becomes an origin.
 */
export const peerOriginsOf = (
  reach: ReadonlyArray<{ readonly kind: string; readonly address: string | null }>,
): ReadonlyArray<string> =>
  reach.flatMap((card) => {
    if (card.kind !== "t3.app" || card.address === null) return [];
    const url = URL.parse(`https://${card.address}`);
    return url !== null && url.host === card.address.toLowerCase() ? [url.origin] : [];
  });
