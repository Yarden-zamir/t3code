import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as RemoteEnvironmentAuthorization from "./service.ts";
import * as TokenStore from "./tokenStore.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

const descriptor = (environmentId: string) =>
  Response.json({
    environmentId,
    label: "Remote environment",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true },
  });

const ticket = () =>
  Response.json({ ticket: "fresh-ticket", expiresAt: "2026-06-06T01:00:00.000Z" });

/** The descriptor answers only when the test releases it, so the test sees what runs meanwhile. */
function gatedFetch(descriptorEnvironmentId: string) {
  const requested: Array<"descriptor" | "ticket"> = [];
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let descriptorRequested = () => {};
  const descriptorStarted = new Promise<void>((resolve) => (descriptorRequested = resolve));
  const fetchFn = ((input) => {
    if (String(input).endsWith("/.well-known/t3/environment")) {
      requested.push("descriptor");
      descriptorRequested();
      return released.then(() => descriptor(descriptorEnvironmentId));
    }
    requested.push("ticket");
    release();
    return Promise.resolve(ticket());
  }) satisfies typeof fetch;
  return { requested, fetchFn, release, descriptorStarted };
}

function authorizationLayer(fetchFn: typeof fetch) {
  const unused = () => Effect.die("unused");
  return RemoteEnvironmentAuthorization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        RpcHttp.layerRemoteHttpClient(fetchFn),
        Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, {
          thumbprint: unused(),
          createProof: unused,
        }),
        Layer.succeed(
          ManagedRelay.ManagedRelayClient,
          new Proxy({} as ManagedRelay.ManagedRelayClient["Service"], { get: () => unused }),
        ),
        Layer.succeed(ClientCapabilities.CloudSession, {
          identity: Effect.succeedNone,
          clerkToken: unused(),
        }),
        Layer.succeed(ClientCapabilities.RelayDeviceIdentity, { deviceId: Effect.succeedNone }),
        Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, {
          get: () => Effect.succeedNone,
          put: unused,
          remove: unused,
        }),
        Layer.succeed(ClientCapabilities.ClientPresentation, {
          metadata: { label: "T3 Code Test", deviceType: "mobile", os: "test" },
        }),
      ),
    ),
  );
}

const authorize = (fetchFn: typeof fetch, origin: string) =>
  Effect.gen(function* () {
    const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
    return yield* remote.authorizeBearer({
      expectedEnvironmentId: ENVIRONMENT_ID,
      httpBaseUrl: `${origin.replace("ws", "http")}/`,
      wsBaseUrl: `${origin}/`,
      bearerToken: "bearer-token",
      connectionMethod: "direct",
    });
  }).pipe(Effect.provide(authorizationLayer(fetchFn)));

describe("RemoteEnvironmentAuthorization bearer request order", () => {
  it.effect("requests the socket ticket while the descriptor is open on HTTPS", () =>
    Effect.gen(function* () {
      const fetch = gatedFetch(ENVIRONMENT_ID);

      const authorized = yield* authorize(fetch.fetchFn, "wss://environment.example.test");

      expect(authorized.socketUrl).toContain("wsTicket=fresh-ticket");
      expect(fetch.requested).toEqual(["descriptor", "ticket"]);
    }),
  );

  it.effect("waits for the descriptor before it sends the token over plain HTTP", () =>
    Effect.gen(function* () {
      const fetch = gatedFetch(ENVIRONMENT_ID);

      const fiber = yield* authorize(fetch.fetchFn, "ws://192.168.1.10:3773").pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.promise(() => fetch.descriptorStarted);
      expect(fetch.requested).toEqual(["descriptor"]);
      fetch.release();
      const authorized = yield* Fiber.join(fiber);

      expect(authorized.socketUrl).toContain("wsTicket=fresh-ticket");
      expect(fetch.requested).toEqual(["descriptor", "ticket"]);
    }),
  );

  it.effect.each(["ws://192.168.1.10:3773", "wss://environment.example.test"])(
    "reports another environment at %s as a configuration error",
    (origin) =>
      Effect.gen(function* () {
        const fetch = gatedFetch("someone-else");
        if (origin.startsWith("ws:")) fetch.release();

        const error = yield* authorize(fetch.fetchFn, origin).pipe(Effect.flip);

        expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
        if (origin.startsWith("ws:")) expect(fetch.requested).toEqual(["descriptor"]);
      }),
  );
});
