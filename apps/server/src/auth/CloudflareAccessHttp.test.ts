import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { answerCheck, layerKitshnConnection } from "../fork/kitshn/KitshnConnection.testkit.ts";
import * as KitshnGrants from "../fork/kitshn/KitshnGrants.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const ALLOWED = "token-of-dev";
const UNLISTED = "token-of-someone";

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-access-test-" });

// K-721: the daemon names dev@example.com at `t3.app` standard and refuses any other token.
const layerKitshn = layerKitshnConnection(
  answerCheck((headers) =>
    headers["cf-access-jwt-assertion"] === ALLOWED
      ? {
          subject: { type: "person", id: "dev@example.com", name: "dev@example.com" },
          levels: { app: "standard" },
          rights: [],
          until: Number.MAX_SAFE_INTEGER,
        }
      : headers["cf-access-jwt-assertion"] === undefined
        ? { anonymous: true }
        : { refused: { code: "no-access", reason: "no grant" } },
  ),
);

const layerGrants = KitshnGrants.layer.pipe(
  Layer.provide(layerKitshn),
  Layer.provide(SessionStore.layer),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
  Layer.provide(NodeServices.layer),
);

const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provideMerge(
    EnvironmentAuth.layer.pipe(
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerEnvironment.layerIdentity),
      Layer.provide(layerGrants),
      Layer.provide(layerConfig),
    ),
  ),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const request = (path: string, init?: { method?: string; headers?: Record<string, string> }) =>
  new Request(`http://127.0.0.1${path}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json", ...init?.headers },
    ...(init?.method === "POST" ? { body: encodeJson({}) } : {}),
  });

const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
  get: () => Effect.succeedNone,
  set: () => Effect.void,
  create: () => Effect.void,
  getOrCreateRandom: () => Effect.die("Not used by these routes."),
  remove: () => Effect.void,
});

it.effect("logs a kitshn visitor in through Access, without a pairing link", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.tryPromise(async () => {
          const allowed = ALLOWED;
          const unlisted = UNLISTED;

          const anonymous = await environment.handler(
            request("/api/auth/session", { headers: { "cf-access-jwt-assertion": unlisted } }),
            requestContext,
          );
          expect(await anonymous.json()).toMatchObject({ authenticated: false });
          expect(anonymous.headers.getSetCookie()).toHaveLength(0);

          const session = await environment.handler(
            request("/api/auth/session", { headers: { "cf-access-jwt-assertion": allowed } }),
            requestContext,
          );
          expect(await session.json()).toMatchObject({ authenticated: true });
          const cookie = session.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "";
          expect(cookie).toMatch(/^t3_session_/);
          const withCookie = await environment.handler(
            request("/api/auth/session", {
              headers: { cookie, "cf-access-jwt-assertion": allowed },
            }),
            requestContext,
          );
          expect(await withCookie.json()).toMatchObject({ authenticated: true });
          // A kitshn session works only through a request that kitshn checks.
          const cookieOnly = await environment.handler(
            request("/api/auth/session", { headers: { cookie } }),
            requestContext,
          );
          expect(await cookieOnly.json()).toMatchObject({ authenticated: false });
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("gives a pairing credential only to a kitshn visitor with a level", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.tryPromise(async () => {
          const path = "/api/auth/cloudflare-access/pairing-credential";
          const rejected = await environment.handler(
            request(path, { method: "POST" }),
            requestContext,
          );
          expect(rejected.status).toBe(401);

          const allowed = ALLOWED;
          const pairing = await environment.handler(
            request(path, { method: "POST", headers: { "cf-access-jwt-assertion": allowed } }),
            requestContext,
          );
          expect(pairing.status).toBe(200);
          const { credential } = (await pairing.json()) as { credential: string };
          const exchange = () =>
            environment.handler(
              new Request("http://127.0.0.1/api/auth/browser-session", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: encodeJson({ credential }),
              }),
              requestContext,
            );
          expect((await exchange()).status).toBe(200);
          expect((await exchange()).status).toBe(401);
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
