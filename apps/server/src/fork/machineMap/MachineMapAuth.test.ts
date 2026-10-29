/**
 * Fork: machine map. The upstream auth hooks: Cloudflare Access pairing for machine tokens
 * (`EnvironmentAuth.issueCloudflareAccessPairingCredential`, MM-1305) and machine sessions at
 * `/mcp` (`McpOAuth.layerMcpClientAuthenticator`, MM-1307), and the pause lock (MM-718).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthStandardClientScopes,
  type ClientAccessMode,
  type MachineDesiredState,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServerRequest } from "effect/http";
import { exportJWK, generateKeyPair } from "jose";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { guardOwnerOnlyPatch } from "./browserAccess.ts";
import { isLocalDesktopSubject } from "./machineAccess.ts";
import { PEER, desiredState } from "./MachineMap.testkit.ts";
import * as MachineMapState from "./MachineMapState.ts";

const ACCESS_TEAM = "team.cloudflareaccess.com";
const CERTS_URL = `https://${ACCESS_TEAM}/cdn-cgi/access/certs`;
const accessKeys = await generateKeyPair("RS256");
const accessJwk = { ...(await exportJWK(accessKeys.publicKey)), kid: "key-1", alg: "RS256" };
// The Access keys come from the team certs URL, so the test serves them from a fetch stub.
const withCertsFetch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) =>
        (input instanceof Request ? input.url : String(input)) === CERTS_URL
          ? Response.json({ keys: [accessJwk] })
          : new Response(null, { status: 404 })) as typeof fetch;
      return realFetch;
    }),
    () => effect,
    (realFetch) => Effect.sync(() => (globalThis.fetch = realFetch)),
  );

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      cloudflareAccess: { teamDomain: ACCESS_TEAM, aud: "aud-tag", subjects: ["dev@example.com"] },
      desktopBootstrapToken: "desktop-token",
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-machine-map-auth-" })));

const layerState = (enabled: boolean, clientAccess: ClientAccessMode = "off") =>
  MachineMapState.layer.pipe(
    Layer.provide(ServerSettings.layerTest({ machineMap: { enabled }, clientAccess })),
    Layer.provide(ServerSecretStore.layer),
  );

const layerAuth = (state: "on" | "off", clientAccess: ClientAccessMode = "off") =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(layerState(state === "on", clientAccess)),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provideMerge(layerConfig),
  );

const bearerRequest = (token: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1/mcp", { headers: { authorization: `Bearer ${token}` } }),
  );

const saveDesired = (desired: MachineDesiredState) =>
  Effect.gen(function* () {
    const state = yield* MachineMapState.MachineMapState;
    yield* state.updateSaved((saved) => ({ ...saved, desired }));
  });

/** Exchanges a credential for a bearer session and authenticates with it. */
const sessionFor = (credential: string) =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const token = yield* auth.exchangeBootstrapCredentialForAccessToken(credential, undefined, {
      deviceType: "bot",
    });
    return yield* auth.authenticateHttpRequest(bearerRequest(token.access_token));
  });

it("the machine map RPCs need the scope of what they change, and the token is desktop-only", () => {
  expect(requiredScopeForRpcMethod(WS_METHODS.machineMapSubscribe)).toBe(
    AuthOrchestrationReadScope,
  );
  // Joining and leaving turn the machineMap setting on and off.
  expect(requiredScopeForRpcMethod(WS_METHODS.machineMapJoin)).toBe(AuthSettingsWriteScope);
  expect(requiredScopeForRpcMethod(WS_METHODS.machineMapLeave)).toBe(AuthSettingsWriteScope);
  expect(requiredScopeForRpcMethod(WS_METHODS.machineMapReportDesktop)).toBe(
    AuthEnvironmentMaintainScope,
  );
  expect(isLocalDesktopSubject("desktop-bootstrap")).toBe(true);
  expect(isLocalDesktopSubject("one-time-token")).toBe(false);
  expect(isLocalDesktopSubject(`machine:${PEER}`)).toBe(false);
});

it.layer(NodeServices.layer)("machine map auth hooks", (it) => {
  it.effect("under enforce, the desktop app and pairing links still get in (MM-918)", () =>
    Effect.gen(function* () {
      yield* saveDesired(desiredState({}));
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const desktop = yield* sessionFor("desktop-token");
      expect(desktop.subject).toBe("desktop-bootstrap");
      const link = yield* auth.createPairingLink({ label: "phone" });
      const paired = yield* sessionFor(link.credential);
      expect(paired.scopes).toEqual(AuthStandardClientScopes);
    }).pipe(withCertsFetch, Effect.provide(layerAuth("on", "enforce"))),
  );

  it.effect("only the local desktop app changes clientAccess or the map setting (MM-919)", () =>
    Effect.gen(function* () {
      const refused = (patch: Parameters<typeof guardOwnerOnlyPatch>[0], subject: string) =>
        Effect.exit(guardOwnerOnlyPatch(patch, subject)).pipe(Effect.map(Exit.isFailure));
      expect(yield* refused({ clientAccess: "off" }, "one-time-token")).toBe(true);
      // Switching the map off would end `enforce` as well.
      expect(yield* refused({ machineMap: { enabled: false } }, "one-time-token")).toBe(true);
      expect(yield* refused({ clientAccess: "off" }, "desktop-bootstrap")).toBe(false);
      expect(yield* refused({}, "one-time-token")).toBe(false);
    }),
  );
});

const pausedReason = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map(
      (exit) =>
        Exit.isFailure(exit) &&
        exit.cause.reasons.some(
          (reason) =>
            reason._tag === "Fail" &&
            EnvironmentAuth.isServerAuthCredentialError(reason.error) &&
            EnvironmentAuth.serverAuthCredentialReason(reason.error) === "machine_paused",
        ),
    ),
  );

/** One session of each kind that the pause must tell apart. */
const sessionsOfEachKind = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const desktop = yield* auth.issueSession({ subject: "desktop-bootstrap" });
  const mobile = yield* auth.issueSession({ subject: "one-time-token" });
  const pairing = yield* auth.issuePairingCredential();
  const browser = yield* auth.createBrowserSession(pairing.credential, { deviceType: "desktop" });
  const cookieRequest = HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1/api/auth/session", {
      headers: { cookie: `${sessions.cookieName}=${browser.sessionToken}` },
    }),
  );
  const mcp = yield* auth.issueMcpClientSession({
    label: "agent",
    access: "full-access",
    peerLink: false,
    client: { deviceType: "bot" },
  });
  return { auth, desktop, mobile, cookieRequest, mcp };
});

it.layer(NodeServices.layer)("machine map pause lock (MM-718)", (it) => {
  it.effect("while paused, only the desktop app and MCP clients authenticate", () =>
    Effect.gen(function* () {
      const { auth, desktop, mobile, cookieRequest, mcp } = yield* sessionsOfEachKind;
      yield* saveDesired(desiredState({ paused: true }));

      expect((yield* auth.authenticateHttpRequest(bearerRequest(desktop.token))).subject).toBe(
        "desktop-bootstrap",
      );
      expect(yield* pausedReason(auth.authenticateHttpRequest(bearerRequest(mobile.token)))).toBe(
        true,
      );
      expect(yield* pausedReason(auth.authenticateWebSocketUpgrade(cookieRequest, "rpc"))).toBe(
        true,
      );
      expect(yield* auth.getSessionState(cookieRequest)).toMatchObject({
        authenticated: false,
        machinePaused: true,
      });
      // A ticket minted before the pause does not open a socket during it.
      const ticket = yield* auth.issueWebSocketTicket({ sessionId: mobile.sessionId });
      const ticketRequest = HttpServerRequest.fromWeb(
        new Request(`http://127.0.0.1/ws?wsTicket=${ticket.ticket}`),
      );
      expect(yield* pausedReason(auth.authenticateWebSocketUpgrade(ticketRequest, "rpc"))).toBe(
        true,
      );
      // MM-711 governs agents; the pause does not lock the MCP endpoint.
      expect((yield* auth.authenticateMcpClient(bearerRequest(mcp.token))).sessionId).toBe(
        mcp.sessionId,
      );
    }).pipe(Effect.provide(layerAuth("on"))),
  );

  it.effect("paused false or an absent flag unlocks at once, and open sockets close on pause", () =>
    Effect.gen(function* () {
      const { auth, mobile, cookieRequest } = yield* sessionsOfEachKind;
      const state = yield* MachineMapState.MachineMapState;
      yield* saveDesired(desiredState({ paused: true }));
      // The socket of a locked session ends at once.
      yield* state.awaitLockFor("one-time-token");
      expect(yield* state.lockedFor("desktop-bootstrap")).toBe(false);

      yield* saveDesired(desiredState({ paused: false }));
      expect((yield* auth.authenticateHttpRequest(bearerRequest(mobile.token))).subject).toBe(
        "one-time-token",
      );
      yield* saveDesired(desiredState({ paused: true }));
      yield* saveDesired(desiredState({}));
      expect((yield* auth.getSessionState(cookieRequest)).authenticated).toBe(true);
    }).pipe(Effect.provide(layerAuth("on"))),
  );

  it.effect("with the machineMap setting off, a saved pause does not lock (MM-1301)", () =>
    Effect.gen(function* () {
      const { auth, mobile } = yield* sessionsOfEachKind;
      yield* saveDesired(desiredState({ paused: true }));
      expect((yield* auth.authenticateHttpRequest(bearerRequest(mobile.token))).subject).toBe(
        "one-time-token",
      );
    }).pipe(Effect.provide(layerAuth("off"))),
  );

  it.effect("an unreadable state file locks until the portal sends a desired state", () =>
    Effect.gen(function* () {
      const { auth, mobile } = yield* sessionsOfEachKind;
      expect(yield* pausedReason(auth.authenticateHttpRequest(bearerRequest(mobile.token)))).toBe(
        true,
      );
      yield* saveDesired(desiredState({}));
      expect((yield* auth.authenticateHttpRequest(bearerRequest(mobile.token))).subject).toBe(
        "one-time-token",
      );
    }).pipe(
      Effect.provide(
        EnvironmentAuth.layer.pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(
            layerState(true).pipe(
              Layer.provide(
                Layer.effectDiscard(
                  Effect.gen(function* () {
                    const config = yield* ServerConfig.ServerConfig;
                    const fileSystem = yield* FileSystem.FileSystem;
                    const path = yield* Path.Path;
                    yield* fileSystem.makeDirectory(config.stateDir, { recursive: true });
                    yield* fileSystem.writeFileString(
                      path.join(config.stateDir, "machine-map.json"),
                      "{ not json",
                    );
                  }),
                ),
              ),
            ),
          ),
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ServerEnvironment.layerIdentity),
          Layer.provideMerge(layerConfig),
        ),
      ),
    ),
  );
});
