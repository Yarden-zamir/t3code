import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const TEST_SERVER_PORT = 13_773;

const layerServerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
        port: TEST_SERVER_PORT,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-server-test-" })));

const layerEnvironmentAuth = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig(overrides)),
  );

const makeCookieRequest = (
  cookieName: string,
  sessionToken: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {
      [cookieName]: sessionToken,
    },
    headers: {},
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};
it.layer(NodeServices.layer)("EnvironmentAuth.layer fork", (it) => {
  it.effect("rejects the desktop bootstrap credential through a tunnel", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const viaTunnel = yield* serverAuth
        .exchangeBootstrapCredentialForAccessToken(
          "desktop-bootstrap-token",
          undefined,
          requestMetadata,
          { forwarded: true },
        )
        .pipe(Effect.flip);
      const browserViaTunnel = yield* serverAuth
        .createBrowserSession("desktop-bootstrap-token", requestMetadata, undefined, true)
        .pipe(Effect.flip);
      // The desktop app itself still pairs.
      const local = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
        { forwarded: false },
      );

      expect(viaTunnel._tag).toBe("ServerAuthInvalidCredentialError");
      expect(browserViaTunnel._tag).toBe("ServerAuthInvalidCredentialError");
      expect(local.access_token.length).toBeGreaterThan(0);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({
          mode: "desktop",
          desktopBootstrapToken: "desktop-bootstrap-token",
          tunnelPairingUrl: "https://t3.example.com",
        }),
      ),
    ),
  );

  it.effect("accepts a forwarded desktop bootstrap credential with tunnel pairing off", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
        { forwarded: true },
      );

      expect(token.access_token.length).toBeGreaterThan(0);
    }).pipe(
      Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
    ),
  );

  it.effect("accepts cookie sessions from configured trusted browser origins", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const pairing = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.createBrowserSession(pairing.credential, requestMetadata);
      const post = (origin: string) =>
        serverAuth.authenticateHttpRequest({
          cookies: { [sessions.cookieName]: exchanged.sessionToken },
          headers: { host: "127.0.0.1:3773", origin, "sec-fetch-site": "same-site" },
        } as never);

      const direct = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(sessions.cookieName, exchanged.sessionToken),
      );
      const trusted = yield* post("https://t3-vps.example.com");
      expect(trusted.sessionId).toBe(direct.sessionId);
      const untrusted = yield* Effect.flip(post("https://elsewhere.example.com"));
      expect(untrusted._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(
      Effect.provide(
        layerEnvironmentAuth({ trustedBrowserOrigins: ["https://t3-vps.example.com"] }),
      ),
    ),
  );
});
