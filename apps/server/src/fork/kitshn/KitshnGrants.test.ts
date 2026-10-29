import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AuthSessionId, MACHINE_LEVEL_SCOPES } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import { PEER, PEER_TOKEN, desiredState } from "../machineMap/MachineMap.testkit.ts";
import { kitshnAgentsAllowMachine, kitshnAgentsAllowRequest } from "./kitshnAgents.ts";
import { appLevelScopes } from "./kitshnGrantRules.ts";
import * as KitshnGrants from "./KitshnGrants.ts";
import { GrantTables } from "./kitshnProviderProtocol.ts";

const decodeTables = Schema.decodeUnknownSync(GrantTables);
const HOUR = 60 * 60 * 1000;

const grant = (rules: ReadonlyArray<unknown>, level: string, endsAt: number | null = null) => ({
  circle: { id: "c", name: "Circle", match: "any", needsPasskey: false, rules },
  level,
  endsAt,
});

/** A request through the tunnel; the test verifier reads the identity from the JWT header. */
const tunnelRequest = (identity: { readonly email?: string; readonly commonName?: string }) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1/api", {
      headers: {
        "cf-access-jwt-assertion": JSON.stringify(identity),
        "cf-connecting-ip": "203.0.113.7",
      },
    }),
  );
const localRequest = HttpServerRequest.fromWeb(new Request("http://127.0.0.1/api"));

const verifyClaims = (request: HttpServerRequest.HttpServerRequest) => {
  const header = request.headers["cf-access-jwt-assertion"];
  if (header === undefined) {
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - The verifier returns undefined for no JWT.
    return Effect.succeed(undefined);
  }
  const identity = JSON.parse(header) as { email?: string; commonName?: string };
  return Effect.succeed({ email: identity.email, commonName: identity.commonName });
};

const kitshnSession = (id: string, scopes = appLevelScopes("standard")) => ({
  sessionId: AuthSessionId.make(id),
  subject: "kitshn:sam@example.com",
  scopes,
});

const harness = Effect.gen(function* () {
  const revoked = yield* Queue.unbounded<AuthSessionId>();
  const revokeFails = yield* Ref.make(false);
  const dependencies = Layer.mergeAll(
    Layer.mock(SessionStore.SessionStore)({
      cookieName: "t3_session",
      legacyCookieName: undefined,
      revoke: (sessionId) =>
        Effect.flatMap(Ref.get(revokeFails), (fails) =>
          fails
            ? Effect.fail(new SessionStore.SessionRevocationError({ sessionId, cause: "offline" }))
            : Queue.offer(revoked, sessionId).pipe(Effect.as(true)),
        ),
    }),
  );
  /** One server lifetime: closing its scope is a restart. */
  const start = Layer.build(
    Layer.effect(KitshnGrants.KitshnGrants, KitshnGrants.make({ verifyClaims })).pipe(
      Layer.provide(dependencies),
    ),
  ).pipe(Effect.map((context) => Context.get(context, KitshnGrants.KitshnGrants)));
  return {
    start,
    /** A server that kitshn answered once, so its grants apply. */
    registered: start.pipe(Effect.tap((grants) => grants.replaceTables({}))),
    revoked,
    revokeFails,
  };
});

const sam = { email: "Sam@Example.com" };

// Each test gets its own state dir, so one test never reads the saved file of another.
const isolated = <A, E>(
  effect: Effect.Effect<A, E, ServerConfig.ServerConfig | NodeServices.NodeServices | Scope.Scope>,
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "kitshn-grants-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("KitshnGrants", () => {
  it.effect("leaves requests without a JWT, and every request before kitshn answered, to T3", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      const grants = yield* test.start;
      const owner = {
        sessionId: AuthSessionId.make("owner"),
        subject: "desktop-paired",
        scopes: MACHINE_LEVEL_SCOPES.admin,
      };
      // Not a kitshn provider yet (K-712): T3's own auth, also for a JWT request.
      expect(yield* grants.active).toBe(false);
      expect(yield* grants.visitor(tunnelRequest(sam))).toBeNull();
      expect(
        yield* KitshnGrants.kitshnAllowsSession(Option.some(grants), tunnelRequest(sam), owner),
      ).toBe(true);

      yield* grants.replaceTables({});
      expect(yield* grants.active).toBe(true);
      expect(yield* grants.visitor(localRequest)).toBeNull();
      expect(
        yield* KitshnGrants.kitshnAllowsSession(Option.some(grants), localRequest, owner),
      ).toBe(true);
      // No grant: a JWT request is refused, also for a session paired another way.
      expect(yield* grants.visitor(tunnelRequest(sam))).toEqual({
        email: "sam@example.com",
        clientId: null,
        ip: "203.0.113.7",
      });
      expect(
        yield* KitshnGrants.kitshnAllowsSession(Option.some(grants), tunnelRequest(sam), owner),
      ).toBe(false);
      // Another machine needs a grant too, and its session works only with the JWT.
      const machine = { ...owner, subject: "machine:vps" };
      expect(
        yield* KitshnGrants.kitshnAllowsSession(
          Option.some(grants),
          tunnelRequest({ commonName: "x" }),
          machine,
        ),
      ).toBe(false);
      expect(
        yield* KitshnGrants.kitshnAllowsSession(Option.some(grants), localRequest, machine),
      ).toBe(false);
      // A kitshn session works only through a request that the grants checked.
      expect(
        yield* KitshnGrants.kitshnAllowsSession(
          Option.some(grants),
          localRequest,
          kitshnSession("k"),
        ),
      ).toBe(false);
    }).pipe(isolated),
  );

  it.effect("replaces the whole table on each event", () =>
    Effect.gen(function* () {
      const grants = yield* (yield* harness).registered;
      const visitor = (yield* grants.visitor(tunnelRequest(sam)))!;
      yield* grants.replaceTables(decodeTables({ app: [grant([{ everyone: true }], "admin")] }));
      expect(yield* grants.level("t3.app", "app", visitor)).toBe("admin");
      yield* grants.replaceTables(decodeTables({ agents: [grant([{ everyone: true }], "use")] }));
      expect(yield* grants.level("t3.app", "app", visitor)).toBeNull();
      expect(yield* grants.level("t3.agents", "agents", visitor)).toBe("use");
    }).pipe(isolated),
  );

  it.effect("ends a kitshn session when its level drops, at endsAt and after 24 hours", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      const grants = yield* test.registered;
      const visitor = (yield* grants.visitor(tunnelRequest(sam)))!;
      const everyone = (level: string, endsAt: number | null = null) =>
        decodeTables({ app: [grant([{ email: "sam@example.com" }], level, endsAt)] });

      yield* grants.replaceTables(everyone("standard"));
      expect(yield* grants.allowsSession(visitor, kitshnSession("drop"))).toBe(true);
      yield* grants.replaceTables(everyone("read"));
      expect(yield* Queue.take(test.revoked)).toBe("drop");

      yield* grants.replaceTables(everyone("standard", 2 * HOUR));
      expect(yield* grants.allowsSession(visitor, kitshnSession("ends"))).toBe(true);
      yield* TestClock.adjust("1 hour");
      expect(yield* Queue.size(test.revoked)).toBe(0);
      yield* TestClock.adjust("1 hour");
      expect(yield* Queue.take(test.revoked)).toBe("ends");

      // Contact keeps the table good; 24 hours without it refuses every JWT request.
      yield* grants.replaceTables(everyone("standard"));
      expect(yield* grants.allowsSession(visitor, kitshnSession("stale"))).toBe(true);
      yield* TestClock.adjust("23 hours");
      yield* grants.contact;
      yield* TestClock.adjust("23 hours");
      expect(yield* grants.level("t3.app", "app", visitor)).toBe("standard");
      yield* TestClock.adjust("1 hour");
      expect(yield* grants.level("t3.app", "app", visitor)).toBeNull();
      expect(yield* Queue.take(test.revoked)).toBe("stale");
    }).pipe(isolated),
  );

  it.effect("keeps the table and a failed revocation on disk across a restart", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const grants = yield* test.registered;
          const visitor = (yield* grants.visitor(tunnelRequest(sam)))!;
          yield* grants.replaceTables(
            decodeTables({ app: [grant([{ domain: "example.com" }], "standard")] }),
          );
          yield* grants.allowsSession(visitor, kitshnSession("saved"));
          yield* Ref.set(test.revokeFails, true);
          yield* grants.replaceTables({});
        }),
      );
      yield* Ref.set(test.revokeFails, false);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const restarted = yield* test.start;
          expect(yield* Queue.take(test.revoked)).toBe("saved");
          yield* restarted.replaceTables(
            decodeTables({ app: [grant([{ everyone: true }], "read")] }),
          );
        }),
      );
      // The table saved before the restart applies until a fresh one arrives.
      const third = yield* test.start;
      const visitor = (yield* third.visitor(tunnelRequest(sam)))!;
      expect(yield* third.level("t3.app", "app", visitor)).toBe("read");
    }).pipe(isolated),
  );

  it.effect("gates the agent tools on use and machine_exec on exec", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      const grants = yield* test.registered;
      const machine = tunnelRequest({ commonName: PEER_TOKEN });
      const desired = desiredState({});
      const gate = Effect.provideService(KitshnGrants.KitshnGrants, grants);

      expect(yield* gate(kitshnAgentsAllowRequest(machine, "use"))).toBe(false);
      yield* grants.replaceTables(
        decodeTables({
          agents: [grant([{ machine: { machineId: PEER, clientId: PEER_TOKEN } }], "use")],
        }),
      );
      expect(yield* gate(kitshnAgentsAllowRequest(machine, "use"))).toBe(true);
      expect(yield* gate(kitshnAgentsAllowMachine(desired, PEER, "exec"))).toBe(false);
      yield* grants.replaceTables(
        decodeTables({
          agents: [grant([{ machine: { machineId: PEER, clientId: PEER_TOKEN } }], "exec")],
        }),
      );
      expect(yield* gate(kitshnAgentsAllowMachine(desired, PEER, "exec"))).toBe(true);
      // Without a JWT, the request keeps T3's own auth.
      expect(yield* gate(kitshnAgentsAllowRequest(localRequest, "exec"))).toBe(true);
    }).pipe(isolated),
  );
});
