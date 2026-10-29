/**
 * Fork: the kitshn grant tables (K-706), enforced for requests with a verified Access JWT once
 * this server is a kitshn provider. Requests without that JWT keep T3's own auth, and without
 * kitshn 2 the server behaves as upstream (K-712). `KitshnProvider` feeds the tables.
 */
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
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import {
  type CloudflareAccessClaims,
  makeCloudflareAccessClaimsVerifier,
} from "../../auth/CloudflareAccess.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import { isMachineSubject } from "../machineMap/machineAccess.ts";
import * as ServerConfig from "../../config.ts";
import {
  type AccessVisitor,
  type GrantState,
  type Kind,
  type LevelOf,
  levelFor,
  nextChangeAt,
  sessionAllowed,
} from "./kitshnGrantRules.ts";
import { GrantTables } from "./kitshnProviderProtocol.ts";

/**
 * The one switch for grant enforcement: this server is a kitshn provider, so kitshn answered a
 * `register` once. The saved file keeps that across a restart. Every gate reads it through
 * `KitshnGrants.active`.
 */
const kitshnAccessActive = (state: GrantState) => state.lastContactAt !== null;

/** The subject of a session that an Access visitor got through a `t3.app` grant. */
export const KITSHN_SESSION_SUBJECT_PREFIX = "kitshn:";
/** A session that exists only through a grant: a person or device, or another machine. */
const isGrantSubject = (subject: string) =>
  subject.startsWith(KITSHN_SESSION_SUBJECT_PREFIX) || isMachineSubject(subject);

const CONNECTING_IP_HEADER = "cf-connecting-ip";
// The time of the last contact goes to disk at most this often, so the 24-hour limit can come
// this much early after a restart.
const CONTACT_SAVE_INTERVAL = Duration.hours(1);
const REVOKE_RETRY = Duration.seconds(30);
// Only sessions of kitshn visitors are kept, one per browser, so the cap is a safety net.
const TRACKED_SESSIONS_LIMIT = 1000;

/** This machine on the kitshn map (K-704). The name is null before the daemon reached kitshn. */
export const KitshnMachine = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
});
export type KitshnMachine = typeof KitshnMachine.Type;

const Saved = Schema.Struct({
  tables: GrantTables,
  lastContactAt: Schema.NullOr(Schema.Number),
  pendingRevocations: Schema.Array(AuthSessionId),
  machine: Schema.NullOr(KitshnMachine).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
type Saved = typeof Saved.Type;
const SavedJson = Schema.fromJsonString(Saved);
const decodeSaved = Schema.decodeUnknownEffect(SavedJson);
const encodeSaved = Schema.encodeEffect(SavedJson);

interface Tracked {
  readonly visitor: AccessVisitor;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

export class KitshnGrants extends Context.Service<
  KitshnGrants,
  {
    /** `kitshnAccessActive` now. */
    readonly active: Effect.Effect<boolean>;
    /**
     * The visitor of a request with a verified Access JWT while this server is a kitshn
     * provider, else null: the request keeps T3's own auth.
     */
    readonly visitor: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AccessVisitor | null>;
    readonly level: <K extends Kind>(
      kind: K,
      resourceId: string,
      visitor: AccessVisitor,
    ) => Effect.Effect<LevelOf<K> | null>;
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
    /** Completes once `allowed` is false: at once, or after a new table, an `endsAt` or the limit. */
    readonly awaitLoss: (allowed: Effect.Effect<boolean>) => Effect.Effect<void>;
    /** K-706: a `register` answer or `grants` event. It replaces the whole set; nothing merges. */
    readonly replaceTables: (tables: GrantTables) => Effect.Effect<void>;
    /** kitshn answered, so the saved table stays good for another 24 hours. */
    readonly contact: Effect.Effect<void>;
    readonly state: Effect.Effect<GrantState>;
    /** This machine, from the last `register` answer; saved, so it holds across a restart. */
    readonly machine: Effect.Effect<KitshnMachine | null>;
    readonly setMachine: (machine: KitshnMachine) => Effect.Effect<void>;
  }
>()("t3/fork/kitshn/KitshnGrants") {}

/**
 * kitshn provider (K-706): the `t3.app` grants decide every request with a verified Access JWT,
 * the sessions of other machines too. A grant session needs such a request every time, so it
 * stops working without the JWT.
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
    : grants.value
        .visitor(request)
        .pipe(
          Effect.flatMap((visitor) =>
            visitor === null
              ? Effect.succeed(!isGrantSubject(session.subject))
              : grants.value.allowsSession(visitor, session),
          ),
        );

export const make = Effect.fn("KitshnGrants.make")(function* (options?: {
  /** Tests replace the Access check. */
  readonly verifyClaims?: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<CloudflareAccessClaims | undefined>;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const sessions = yield* SessionStore.SessionStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = path.join(config.stateDir, "kitshn-grants.json");
  const verifyClaims =
    options?.verifyClaims ??
    (config.cloudflareAccess === undefined
      ? undefined
      : makeCloudflareAccessClaimsVerifier(config.cloudflareAccess));

  // A missing file starts with no table, so every Access request is refused until kitshn
  // answers. A broken one does the same and says why.
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
        Effect.as({ tables: {}, lastContactAt: null, pendingRevocations: [], machine: null }),
      ),
    ),
  );
  const state = yield* SubscriptionRef.make<GrantState>({
    tables: loaded.tables,
    lastContactAt: loaded.lastContactAt,
  });
  const pending = new Set<AuthSessionId>(loaded.pendingRevocations);
  let machine = loaded.machine;
  let savedContactAt = loaded.lastContactAt;
  const tracked = new Map<AuthSessionId, Tracked>();
  const writes = yield* Semaphore.make(1);

  const save = writes.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      savedContactAt = current.lastContactAt;
      yield* encodeSaved({ ...current, pendingRevocations: [...pending], machine }).pipe(
        Effect.flatMap((contents) => writeFileStringAtomically({ filePath: statePath, contents })),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("kitshn grants: could not save the file.", { cause: String(cause) }),
      ),
    ),
  );

  const active = Effect.map(SubscriptionRef.get(state), kitshnAccessActive);

  const visitor: KitshnGrants["Service"]["visitor"] = Effect.fn("KitshnGrants.visitor")(
    function* (request) {
      if (verifyClaims === undefined || !(yield* active)) return null;
      const claims = yield* verifyClaims(request);
      if (claims === undefined) return null;
      const ip = request.headers[CONNECTING_IP_HEADER];
      return {
        email: claims.email?.toLowerCase() ?? null,
        clientId: claims.commonName ?? null,
        ip: typeof ip === "string" && ip.length > 0 ? ip : null,
      } satisfies AccessVisitor;
    },
  );

  const level: KitshnGrants["Service"]["level"] = (kind, resourceId, visitor) =>
    Effect.all([SubscriptionRef.get(state), Clock.currentTimeMillis]).pipe(
      Effect.map(([current, nowMs]) => levelFor(current, kind, resourceId, visitor, nowMs)),
    );

  const allowsSession: KitshnGrants["Service"]["allowsSession"] = Effect.fn(
    "KitshnGrants.allowsSession",
  )(function* (visitor, session) {
    const [current, nowMs] = yield* Effect.all([
      SubscriptionRef.get(state),
      Clock.currentTimeMillis,
    ]);
    const allowed = sessionAllowed(current, session, visitor, nowMs);
    if (allowed && isGrantSubject(session.subject)) {
      tracked.delete(session.sessionId);
      tracked.set(session.sessionId, { visitor, scopes: session.scopes });
      if (tracked.size > TRACKED_SESSIONS_LIMIT) {
        tracked.delete(tracked.keys().next().value!);
      }
    }
    return allowed;
  });

  const awaitLoss: KitshnGrants["Service"]["awaitLoss"] = (allowed) =>
    SubscriptionRef.changes(state).pipe(
      Stream.mapEffect(() => allowed),
      Stream.filter((stillAllowed) => !stillAllowed),
      Stream.runHead,
      Effect.asVoid,
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

  /** Ends the tracked kitshn sessions whose visitor lost the level that the session holds. */
  // One at a time, so `replaceTables` returns only after a lost session is on disk.
  const reconciling = yield* Semaphore.make(1);
  const reconcile = Effect.fn("KitshnGrants.reconcile")(function* (current: GrantState) {
    const nowMs = yield* Clock.currentTimeMillis;
    const lost = [...tracked].filter(
      ([, entry]) => !sessionAllowed(current, entry, entry.visitor, nowMs),
    );
    if (lost.length === 0) return;
    for (const [sessionId] of lost) {
      tracked.delete(sessionId);
      pending.add(sessionId);
    }
    yield* Effect.logInfo(`kitshn grants: ${lost.length} sessions lost their access.`);
    yield* revokePending;
  }, reconciling.withPermits(1));

  // Each change, `endsAt` and the 24-hour limit wake the readers of `state`.
  yield* SubscriptionRef.changes(state).pipe(
    Stream.switchMap((current) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          yield* reconcile(current);
          const nowMs = yield* Clock.currentTimeMillis;
          const next = nextChangeAt(current, nowMs);
          if (next === null) return yield* Effect.never;
          yield* Effect.sleep(Duration.millis(next - nowMs));
          yield* SubscriptionRef.update(state, (latest) => ({ ...latest }));
        }),
      ),
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );
  yield* Effect.suspend(() => (pending.size === 0 ? Effect.void : revokePending)).pipe(
    Effect.repeat(Schedule.spaced(REVOKE_RETRY)),
    Effect.forkScoped,
  );

  const replaceTables: KitshnGrants["Service"]["replaceTables"] = Effect.fn(
    "KitshnGrants.replaceTables",
  )(function* (tables) {
    const nowMs = yield* Clock.currentTimeMillis;
    const next = { tables, lastContactAt: nowMs };
    yield* SubscriptionRef.set(state, next);
    yield* save;
    // At once, so a lost session is on disk before anything else runs.
    yield* reconcile(next);
  });

  const contact: KitshnGrants["Service"]["contact"] = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.update(state, (current) => ({ ...current, lastContactAt: nowMs }));
    if (
      savedContactAt === null ||
      nowMs - savedContactAt >= Duration.toMillis(CONTACT_SAVE_INTERVAL)
    ) {
      yield* save;
    }
  });

  return KitshnGrants.of({
    active,
    visitor,
    level,
    allowsSession,
    awaitLoss,
    replaceTables,
    contact,
    state: SubscriptionRef.get(state),
    machine: Effect.sync(() => machine),
    setMachine: Effect.fn("KitshnGrants.setMachine")(function* (next) {
      if (machine?.id === next.id && machine.name === next.name) return;
      machine = next;
      yield* save;
    }),
  });
});

export const layer = Layer.effect(KitshnGrants, make());
