/**
 * Fork: kitshn access for requests that carry an identity (K-721, protocol 2). The daemon checks
 * the identity headers and answers the levels of the subject (`check`); T3 never reads the Access
 * token. Requests without an identity keep T3's own auth, and without kitshn 2 the server behaves
 * as upstream (K-712).
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The cache key is a sync hash of the headers.
import * as NodeCrypto from "node:crypto";

import type { CheckRefusal } from "@kitshn/local";
import { AuthSessionId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import { isMachineSubject } from "../machineMap/machineAccess.ts";
import * as KitshnConnection from "./KitshnConnection.ts";
import { peerOriginsOf, sessionAllowed } from "./kitshnGrantRules.ts";

/** The subject of a session that a person or device got through a `t3.app` level. */
export const KITSHN_SESSION_SUBJECT_PREFIX = "kitshn:";
/** A session that exists only through kitshn: a person or device, or another machine. */
const isGrantSubject = (subject: string) =>
  subject.startsWith(KITSHN_SESSION_SUBJECT_PREFIX) || isMachineSubject(subject);

// K-721: at most 50 keys in one `check`.
const CHECK_BATCH = 50;
// The headers of a request without an Access token name no one; the daemon answer holds a while.
const ANONYMOUS_LIFETIME = Duration.minutes(5);
// A refusal can end without `grants-changed`: kitshn came back (`stale`), or the keys rotated (`invalid`).
const REFUSAL_LIFETIME = Duration.minutes(1);
const REVOKE_RETRY = Duration.seconds(30);
// Only sessions and visitors of kitshn are kept, so the caps are a safety net.
const TRACKED_SESSIONS_LIMIT = 1000;
const CACHED_VISITORS_LIMIT = 1000;

/** This machine on the kitshn map (K-704). The name is null before the daemon reached kitshn. */
export const KitshnMachine = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
});
export type KitshnMachine = typeof KitshnMachine.Type;

const Saved = Schema.Struct({
  pendingRevocations: Schema.Array(AuthSessionId),
  machine: Schema.NullOr(KitshnMachine),
});
type Saved = typeof Saved.Type;
const SavedJson = Schema.fromJsonString(Saved);
const decodeSaved = Schema.decodeUnknownEffect(SavedJson);
const encodeSaved = Schema.encodeEffect(SavedJson);

/** Who a request with an identity is, by kitshn's `check`, and until when the answer holds. */
export interface AccessVisitor {
  readonly key: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly subject: {
    readonly type: "person" | "device" | "machine";
    readonly id: string;
    readonly name: string;
  };
  /** The provider level names, by resource id, of the resources that the subject reaches. */
  readonly levels: Readonly<Record<string, string>>;
  /** K-722: the subject is a machine whose "runs commands" covers this machine at automatic. */
  readonly exec: boolean;
  readonly until: number;
}

export type VisitorResult =
  /** The request names no one: T3's own auth decides. */
  | { readonly _tag: "anonymous" }
  /** `unavailable`: no daemon answered or it could not verify, so no new session (fail closed). */
  | { readonly _tag: "refused"; readonly code: CheckRefusal }
  | { readonly _tag: "visitor"; readonly visitor: AccessVisitor };

type Cached =
  | { readonly _tag: "anonymous"; readonly until: number }
  /** A refusal holds a short time, so refused requests do not each ask the daemon. */
  | { readonly _tag: "refused"; readonly code: CheckRefusal; readonly until: number }
  | { readonly _tag: "visitor"; readonly visitor: AccessVisitor };

interface Tracked {
  readonly key: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

export class KitshnGrants extends Context.Service<
  KitshnGrants,
  {
    /** This server registered with kitshn once (K-704); saved across a restart. */
    readonly active: Effect.Effect<boolean>;
    readonly visitor: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<VisitorResult>;
    /**
     * True when the session holds no scope above the `t3.app` level of the visitor. A grant
     * session that passes is tracked, so it ends when its visitor loses that level.
     */
    readonly allowsSession: (
      visitor: AccessVisitor,
      session: {
        readonly sessionId: AuthSessionId;
        readonly subject: string;
        readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
      },
    ) => Effect.Effect<boolean>;
    /**
     * Completes when the visitor's latest answer no longer passes `allowed`: after a re-check on
     * `grants-changed`, or at its `until`.
     */
    readonly awaitLoss: (
      visitor: AccessVisitor,
      allowed: (latest: AccessVisitor) => boolean,
    ) => Effect.Effect<void>;
    /** K-722: a machine session of `machineId` holds "runs commands" here now. */
    readonly machineMayExec: (machineId: string) => Effect.Effect<boolean>;
    /** This machine, from the last `register` answer; saved, so it holds across a restart. */
    readonly machine: Effect.Effect<KitshnMachine | null>;
    /** MM-1311: true for the origin of a linked machine's app. Sync: each request reads it. */
    readonly trustsPeerOrigin: (origin: string) => boolean;
    /** MM-1311: the trusted peer origins, sorted, for the server config of the clients. */
    readonly peerOrigins: () => ReadonlyArray<string>;
  }
>()("t3/fork/kitshn/KitshnGrants") {}

/**
 * K-721: the identity decides every request that carries one, the sessions of other machines too.
 * A grant session needs such a request every time, so it stops working without the identity.
 */
export const kitshnAllowsSession = (
  grants: Option.Option<KitshnGrants["Service"]>,
  request: HttpServerRequest.HttpServerRequest,
  session: {
    readonly sessionId: AuthSessionId;
    readonly subject: string;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  },
): Effect.Effect<boolean> =>
  Option.isNone(grants)
    ? Effect.succeed(true)
    : grants.value.visitor(request).pipe(
        Effect.flatMap((result) => {
          switch (result._tag) {
            case "anonymous":
              return Effect.succeed(!isGrantSubject(session.subject));
            case "refused":
              return Effect.succeed(false);
            case "visitor":
              return grants.value.allowsSession(result.visitor, session);
          }
        }),
      );

/**
 * K-721: `unavailable` means that the daemon could not verify now, for example without the Access
 * signing keys. It refuses a new session but ends no session.
 */
const isTemporary = (code: CheckRefusal) => code === "unavailable";

/** The cache key of a set of identity headers: one hash, so no token sits in a map key. */
const keyOf = (headers: Readonly<Record<string, string>>) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(Object.entries(headers).toSorted(([a], [b]) => a.localeCompare(b))))
    .digest("hex")
    .slice(0, 48);

type CheckResult = Extract<
  KitshnConnection.AnswerOf<"check">,
  { readonly type: "check" }
>["results"][number];

const toCached = (
  result: CheckResult,
  headers: Readonly<Record<string, string>>,
  nowMs: number,
):
  | Exclude<Cached, { readonly _tag: "refused" }>
  | { readonly _tag: "refused"; readonly code: CheckRefusal } => {
  if ("anonymous" in result) {
    return { _tag: "anonymous", until: nowMs + Duration.toMillis(ANONYMOUS_LIFETIME) };
  }
  if ("refused" in result) return { _tag: "refused", code: result.refused.code };
  return {
    _tag: "visitor",
    visitor: {
      key: result.key,
      headers,
      subject: result.subject,
      levels: result.levels,
      exec: result.rights.includes("exec"),
      until: result.until,
    },
  };
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const sessions = yield* SessionStore.SessionStore;
  const kitshn = yield* KitshnConnection.KitshnConnection;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = path.join(config.stateDir, "kitshn-grants.json");

  // A missing file starts with no machine. A broken one does the same and says why.
  const loaded: Saved = yield* fileSystem.readFileString(statePath).pipe(
    Effect.flatMap(decodeSaved),
    Effect.catch((cause) =>
      fileSystem.exists(statePath).pipe(
        Effect.orElseSucceed(() => false),
        Effect.flatMap((exists) =>
          exists
            ? Effect.logWarning("kitshn grants: the saved file is unreadable.", {
                cause: String(cause),
              })
            : Effect.void,
        ),
        Effect.as({ pendingRevocations: [], machine: null }),
      ),
    ),
  );
  const pending = new Set<AuthSessionId>(loaded.pendingRevocations);
  let machine = loaded.machine;
  // The headers of the last register answer; they stay known while the daemon is away.
  let identityHeaders: ReadonlyArray<string> = [];
  let peerOrigins: ReadonlySet<string> = new Set();
  const cache = new Map<string, Cached>();
  const tracked = new Map<AuthSessionId, Tracked>();
  // Each re-check bumps it, so `awaitLoss` reads the cache again.
  const generation = yield* SubscriptionRef.make(0);
  const writes = yield* Semaphore.make(1);

  const save = writes.withPermits(1)(
    Effect.suspend(() => encodeSaved({ pendingRevocations: [...pending], machine })).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: statePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catch((cause) =>
        Effect.logWarning("kitshn grants: could not save the file.", { cause: String(cause) }),
      ),
    ),
  );

  const remember = (key: string, entry: Cached) => {
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > CACHED_VISITORS_LIMIT) cache.delete(cache.keys().next().value!);
  };

  const identityOf = (request: HttpServerRequest.HttpServerRequest) => {
    const headers: Record<string, string> = {};
    for (const name of identityHeaders) {
      const value = request.headers[name];
      if (typeof value === "string" && value.length > 0) headers[name] = value;
    }
    return headers;
  };

  const visitor: KitshnGrants["Service"]["visitor"] = Effect.fn("KitshnGrants.visitor")(
    function* (request) {
      const live = yield* kitshn.current;
      if (live !== null) {
        identityHeaders = live.answer.identityHeaders.map((name) => name.toLowerCase());
      }
      const headers = identityOf(request);
      if (Object.keys(headers).length === 0) return { _tag: "anonymous" } as const;
      const key = keyOf(headers);
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = cache.get(key);
      if (cached !== undefined) {
        const until = cached._tag === "visitor" ? cached.visitor.until : cached.until;
        if (until > nowMs) {
          if (cached._tag === "refused") return { _tag: "refused", code: cached.code } as const;
          return cached._tag === "visitor" ? cached : ({ _tag: "anonymous" } as const);
        }
        cache.delete(key);
      }
      const sentAt = yield* kitshn.grantsEpoch;
      const answer = yield* kitshn
        .request({ type: "check", requests: [{ key, headers }] })
        .pipe(Effect.option);
      const result = Option.isSome(answer)
        ? answer.value.results.find((entry) => entry.key === key)
        : undefined;
      if (result === undefined) return { _tag: "refused", code: "unavailable" } as const;
      // The grants changed while this check ran: its answer can be older than a re-check's.
      if ((yield* kitshn.grantsEpoch) !== sentAt) return yield* visitor(request);
      const next = toCached(result, headers, nowMs);
      if (next._tag === "refused") {
        if (!isTemporary(next.code)) {
          remember(key, { ...next, until: nowMs + Duration.toMillis(REFUSAL_LIFETIME) });
        }
        return next;
      }
      remember(key, next);
      return next._tag === "visitor" ? next : ({ _tag: "anonymous" } as const);
    },
  );

  const allowsSession: KitshnGrants["Service"]["allowsSession"] = (current, session) =>
    Effect.sync(() => {
      const allowed = sessionAllowed(session, current.levels);
      if (allowed && isGrantSubject(session.subject)) {
        tracked.delete(session.sessionId);
        tracked.set(session.sessionId, { key: current.key, scopes: session.scopes });
        if (tracked.size > TRACKED_SESSIONS_LIMIT) tracked.delete(tracked.keys().next().value!);
      }
      return allowed;
    });

  /** The latest answer of a visitor's key, or null once it no longer names a live visitor. */
  const latest = (key: string, nowMs: number): AccessVisitor | null => {
    const cached = cache.get(key);
    return cached?._tag === "visitor" && cached.visitor.until > nowMs ? cached.visitor : null;
  };

  const awaitLoss: KitshnGrants["Service"]["awaitLoss"] = (current, allowed) =>
    Effect.raceFirst(
      SubscriptionRef.changes(generation).pipe(
        Stream.mapEffect(() =>
          Clock.currentTimeMillis.pipe(Effect.map((nowMs) => latest(current.key, nowMs))),
        ),
        Stream.filter((now) => now === null || !allowed(now)),
        Stream.runHead,
        Effect.asVoid,
      ),
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) =>
          Effect.sleep(Duration.millis(Math.max(0, current.until - nowMs))),
        ),
      ),
    );

  /** K-706 rule 7, MM-1306: revocations wait on disk until the session store took them. */
  const revokePending = Effect.gen(function* () {
    for (const sessionId of pending) {
      const done = yield* sessions.revoke(sessionId).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("kitshn grants: a session revocation failed; it runs again.", {
            cause: String(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      if (done) pending.delete(sessionId);
    }
    yield* save;
  });

  /**
   * K-721: `grants-changed` checks every cached visitor again in batches. A session whose visitor
   * was refused or lost its level ends; one whose token only expired is dropped, not revoked.
   */
  const recheckAll = Effect.fn("KitshnGrants.recheckAll")(function* () {
    const entries = [...cache].flatMap(([key, entry]) =>
      entry._tag === "visitor" ? [{ key, headers: entry.visitor.headers }] : [],
    );
    // Anonymous answers and refusals can change, so they are asked again on the next request.
    for (const [key, entry] of cache) if (entry._tag !== "visitor") cache.delete(key);
    const expired = new Set<string>();
    const lostAccess = new Set<string>();
    for (let start = 0; start < entries.length; start += CHECK_BATCH) {
      const batch = entries.slice(start, start + CHECK_BATCH);
      const sentAt = yield* kitshn.grantsEpoch;
      const answer = yield* kitshn.request({ type: "check", requests: batch }).pipe(Effect.option);
      // No answer: the cached levels hold until their `until` (fail closed for new sessions only).
      if (Option.isNone(answer)) continue;
      // A newer change came in meanwhile; its own re-check, queued behind this one, decides.
      if ((yield* kitshn.grantsEpoch) !== sentAt) continue;
      const nowMs = yield* Clock.currentTimeMillis;
      for (const { key, headers } of batch) {
        const result = answer.value.results.find((entry) => entry.key === key);
        const next = result === undefined ? undefined : toCached(result, headers, nowMs);
        if (next === undefined) continue;
        if (next._tag === "refused") {
          // The daemon could not verify now: the answer that T3 holds stays until its `until`.
          if (isTemporary(next.code)) continue;
          cache.delete(key);
          (next.code === "expired" ? expired : lostAccess).add(key);
          continue;
        }
        cache.set(key, next);
      }
    }
    const lost: Array<AuthSessionId> = [];
    for (const [sessionId, entry] of tracked) {
      if (expired.has(entry.key)) {
        tracked.delete(sessionId);
        continue;
      }
      const current = cache.get(entry.key);
      const keeps =
        !lostAccess.has(entry.key) &&
        (current === undefined ||
          (current._tag === "visitor" && sessionAllowed(entry, current.visitor.levels)));
      if (!keeps) {
        tracked.delete(sessionId);
        lost.push(sessionId);
      }
    }
    // A lost session is on disk before any reader of the new answers runs.
    if (lost.length > 0) {
      for (const sessionId of lost) pending.add(sessionId);
      yield* save;
      yield* Effect.logInfo(`kitshn grants: ${lost.length} sessions lost their access.`);
    }
    yield* SubscriptionRef.update(generation, (value) => value + 1);
    if (lost.length > 0) yield* revokePending;
  });
  const rechecks = yield* Semaphore.make(1);

  const setMachine = Effect.fn("KitshnGrants.setMachine")(function* (next: KitshnMachine) {
    if (machine?.id === next.id && machine.name === next.name) return;
    machine = next;
    yield* save;
  });

  // The connection at start meets an empty cache; a later one can follow a change T3 did not hear.
  let reconnect = false;
  yield* kitshn.live.pipe(
    Stream.runForEach((connection) =>
      connection === null
        ? Effect.void
        : Effect.gen(function* () {
            peerOrigins = new Set(peerOriginsOf(connection.answer.saved.reach));
            yield* setMachine(connection.answer.machine);
            if (reconnect) yield* rechecks.withPermits(1)(recheckAll());
            reconnect = true;
          }),
    ),
    Effect.forkScoped,
  );
  const subscription = yield* kitshn.subscribe;
  yield* PubSub.take(subscription).pipe(
    Effect.flatMap((event) => {
      if (event.type === "grants-changed") return rechecks.withPermits(1)(recheckAll());
      if (event.type === "reach") {
        return Effect.sync(() => {
          peerOrigins = new Set(peerOriginsOf(event.cards));
        });
      }
      return Effect.void;
    }),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* Effect.suspend(() => (pending.size === 0 ? Effect.void : revokePending)).pipe(
    Effect.repeat(Schedule.spaced(REVOKE_RETRY)),
    Effect.forkScoped,
  );

  return KitshnGrants.of({
    active: Effect.sync(() => machine !== null),
    visitor,
    allowsSession,
    awaitLoss,
    machineMayExec: Effect.fn("KitshnGrants.machineMayExec")(function* (machineId) {
      const nowMs = yield* Clock.currentTimeMillis;
      return [...cache.values()].some(
        (entry) =>
          entry._tag === "visitor" &&
          entry.visitor.until > nowMs &&
          entry.visitor.subject.type === "machine" &&
          entry.visitor.subject.id === machineId &&
          entry.visitor.exec,
      );
    }),
    machine: Effect.sync(() => machine),
    trustsPeerOrigin: (origin) => peerOrigins.has(origin),
    peerOrigins: () => [...peerOrigins].toSorted(),
  });
});

export const layer = Layer.effect(KitshnGrants, make);
