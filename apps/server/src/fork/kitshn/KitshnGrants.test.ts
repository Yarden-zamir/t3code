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
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import { kitshnMachineMcpClient } from "../forkEnvironmentAuth.ts";
import * as KitshnConnection from "./KitshnConnection.ts";
import { answerCheck, type CheckAnswer, registerAnswer } from "./KitshnConnection.testkit.ts";
import { appLevelScopes } from "./kitshnGrantRules.ts";
import * as KitshnGrants from "./KitshnGrants.ts";

const HOUR = 60 * 60 * 1000;

const tunnelRequest = (token: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1/api", {
      headers: { "cf-access-jwt-assertion": token, "cf-connecting-ip": "203.0.113.7" },
    }),
  );
const localRequest = HttpServerRequest.fromWeb(new Request("http://127.0.0.1/api"));

const person = (levels: Record<string, string>, until = HOUR): CheckAnswer => ({
  subject: { type: "person", id: "sam@example.com", name: "Sam" },
  levels,
  rights: [],
  until,
});

const kitshnSession = (id: string, scopes = appLevelScopes("standard")) => ({
  sessionId: AuthSessionId.make(id),
  subject: "kitshn:person:sam@example.com",
  scopes,
});

const harness = Effect.gen(function* () {
  const revoked = yield* Queue.unbounded<AuthSessionId>();
  const revokeFails = yield* Ref.make(false);
  /** The daemon's answer for each token; a missing token is anonymous. */
  const answers = yield* Ref.make(new Map<string, CheckAnswer>());
  const checks = yield* Ref.make(0);
  const connection = yield* KitshnConnection.make;
  const daemon = {
    answer: registerAnswer(),
    request: (input: KitshnConnection.LocalRequestInput) =>
      Effect.gen(function* () {
        yield* Ref.update(checks, (count) => count + 1);
        const current = yield* Ref.get(answers);
        return yield* answerCheck(
          (headers) => current.get(headers["cf-access-jwt-assertion"] ?? "") ?? { anonymous: true },
        )(input);
      }),
    notify: () => Effect.void,
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(KitshnConnection.KitshnConnection, connection),
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
  const start = Layer.build(KitshnGrants.layer.pipe(Layer.provide(dependencies))).pipe(
    Effect.map((context) => Context.get(context, KitshnGrants.KitshnGrants)),
  );
  return {
    start,
    connect: connection.attach(daemon),
    disconnect: connection.attach(null),
    grantsChanged: connection.publish({ type: "grants-changed", at: 0 }),
    answers,
    checks,
    revoked,
    revokeFails,
  };
});

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

const visitorOf = (result: KitshnGrants.VisitorResult) => {
  if (result._tag !== "visitor") throw new Error(`expected a visitor, got ${result._tag}`);
  return result.visitor;
};

describe("KitshnGrants (K-721)", () => {
  it.effect("leaves requests without an identity to T3, and fails closed without a daemon", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      const grants = yield* test.start;
      const owner = {
        sessionId: AuthSessionId.make("owner"),
        subject: "desktop-paired",
        scopes: MACHINE_LEVEL_SCOPES.admin,
      };
      // Before any register the identity headers are unknown, so every request is T3's own.
      expect(yield* grants.visitor(tunnelRequest("sam"))).toEqual({ _tag: "anonymous" });
      yield* test.connect;
      expect(yield* grants.visitor(localRequest)).toEqual({ _tag: "anonymous" });
      expect(
        yield* KitshnGrants.kitshnAllowsSession(Option.some(grants), localRequest, owner),
      ).toBe(true);
      expect(
        yield* KitshnGrants.kitshnAllowsSession(
          Option.some(grants),
          localRequest,
          kitshnSession("s"),
        ),
      ).toBe(false);
      expect(yield* Ref.get(test.checks)).toBe(0);
      // The daemon says that the headers name no one: still T3's own auth.
      expect(yield* grants.visitor(tunnelRequest("nobody"))).toEqual({ _tag: "anonymous" });
      yield* test.disconnect;
      // D5: an identity with no daemon to check it opens nothing.
      expect(yield* grants.visitor(tunnelRequest("sam"))).toEqual({
        _tag: "refused",
        code: "unavailable",
      });
    }).pipe(isolated),
  );

  it.effect("checks each token once and again after its until", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      yield* Ref.set(test.answers, new Map([["sam", person({ app: "standard" })]]));
      yield* test.connect;
      const grants = yield* test.start;
      const first = visitorOf(yield* grants.visitor(tunnelRequest("sam")));
      expect(first.levels).toEqual({ app: "standard" });
      const cached = yield* Ref.get(test.checks);
      yield* grants.visitor(tunnelRequest("sam"));
      expect(yield* Ref.get(test.checks)).toBe(cached);
      yield* TestClock.adjust(HOUR);
      yield* grants.visitor(tunnelRequest("sam"));
      expect(yield* Ref.get(test.checks)).toBe(cached + 1);
    }).pipe(isolated),
  );

  it.effect("re-checks on grants-changed: revokes a lowered session, drops an expired one", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      yield* Ref.set(
        test.answers,
        new Map([
          ["sam", person({ app: "admin" })],
          ["kim", person({ app: "standard" })],
        ]),
      );
      yield* test.connect;
      const grants = yield* test.start;
      const sam = visitorOf(yield* grants.visitor(tunnelRequest("sam")));
      const kim = visitorOf(yield* grants.visitor(tunnelRequest("kim")));
      expect(yield* grants.allowsSession(sam, kitshnSession("sam", appLevelScopes("admin")))).toBe(
        true,
      );
      expect(yield* grants.allowsSession(kim, kitshnSession("kim"))).toBe(true);

      yield* Ref.set(
        test.answers,
        new Map<string, CheckAnswer>([
          ["sam", person({ app: "standard" })],
          ["kim", { refused: { code: "expired", reason: "token expired" } }],
        ]),
      );
      yield* test.grantsChanged;
      // An admin session above the new standard level ends; an expired token ends nothing.
      expect(yield* Queue.take(test.revoked)).toBe("sam");
      yield* grants.awaitLoss(kim, () => true);
      expect(yield* Queue.poll(test.revoked)).toEqual(Option.none());

      // The daemon cannot verify now: no session ends, and a new token is refused.
      const kept = visitorOf(yield* grants.visitor(tunnelRequest("sam")));
      yield* grants.allowsSession(kept, kitshnSession("sam-2"));
      const unavailable: CheckAnswer = {
        refused: { code: "unavailable", reason: "no signing keys" },
      };
      yield* Ref.set(
        test.answers,
        new Map([
          ["sam", unavailable],
          ["new", unavailable],
        ]),
      );
      yield* test.grantsChanged;
      expect(yield* grants.visitor(tunnelRequest("new"))).toEqual({
        _tag: "refused",
        code: "unavailable",
      });
      // The next re-check raises Sam's level; it runs after the one above, so both ran.
      yield* Ref.set(test.answers, new Map([["sam", person({ app: "admin" })]]));
      yield* test.grantsChanged;
      yield* grants.awaitLoss(kept, (latest) => latest.levels.app === "standard");
      expect(yield* Queue.poll(test.revoked)).toEqual(Option.none());
    }).pipe(isolated),
  );

  it.effect("keeps a failed revocation on disk and runs it after a restart", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      yield* Ref.set(test.answers, new Map([["sam", person({ app: "standard" })]]));
      yield* test.connect;
      yield* Ref.set(test.revokeFails, true);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const grants = yield* test.start;
          const sam = visitorOf(yield* grants.visitor(tunnelRequest("sam")));
          yield* grants.allowsSession(sam, kitshnSession("sam"));
          yield* Ref.set(
            test.answers,
            new Map<string, CheckAnswer>([
              ["sam", { refused: { code: "no-access", reason: "no grant" } }],
            ]),
          );
          yield* test.grantsChanged;
          yield* grants.awaitLoss(sam, () => true);
        }),
      );
      yield* Ref.set(test.revokeFails, false);
      yield* test.start;
      expect(yield* Queue.take(test.revoked)).toBe("sam");
    }).pipe(isolated),
  );

  it.effect("gives another machine its MCP session and exec by kitshn's answer only", () =>
    Effect.gen(function* () {
      const test = yield* harness;
      yield* Ref.set(
        test.answers,
        new Map<string, CheckAnswer>([
          [
            "vps-token",
            {
              subject: { type: "machine", id: "vps", name: "vps" },
              levels: { app: "standard" },
              rights: ["exec"],
              until: HOUR,
            },
          ],
          [
            "pi-token",
            {
              subject: { type: "machine", id: "pi", name: "pi" },
              levels: { app: "read" },
              rights: [],
              until: HOUR,
            },
          ],
        ]),
      );
      yield* test.connect;
      const grants = yield* test.start;
      const session = (machine: string) => ({
        subject: `machine:${machine}`,
        method: "bearer-access-token",
        scopes: MACHINE_LEVEL_SCOPES.standard,
      });
      const client = yield* kitshnMachineMcpClient(tunnelRequest("vps-token"), session("vps")).pipe(
        Effect.provideService(KitshnGrants.KitshnGrants, grants),
      );
      expect(client).toMatchObject({ machineId: "vps", access: "auto", peerLink: true });
      // The token of one machine never opens the session of another.
      expect(
        yield* kitshnMachineMcpClient(tunnelRequest("vps-token"), session("pi")).pipe(
          Effect.provideService(KitshnGrants.KitshnGrants, grants),
        ),
      ).toBeUndefined();
      yield* kitshnMachineMcpClient(tunnelRequest("pi-token"), session("pi")).pipe(
        Effect.provideService(KitshnGrants.KitshnGrants, grants),
      );
      expect(yield* grants.machineMayExec("vps")).toBe(true);
      expect(yield* grants.machineMayExec("pi")).toBe(false);
    }).pipe(isolated),
  );
});
