import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ConnectionResolver from "./resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { ConnectionBlockedError, PrimaryConnectionTarget } from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as RpcHttp from "../rpc/http.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function catalogEntry(target: PrimaryConnectionTarget): ConnectionCatalogEntry {
  return { target, profile: Option.none(), enabled: true };
}

const makeDependencies = Effect.fn("TestConnectionResolver.makeDependencies")((options: {
  readonly authorizeBearer: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeBearer"];
  readonly primaryBearerToken: string;
  readonly refreshBearerToken: NonNullable<
    ClientCapabilities.PrimaryEnvironmentAuth["Service"]["refreshBearerToken"]
  >;
}) => {
  const layerDependencies = Layer.mergeAll(
    RpcHttp.layerRemoteHttpClient((() =>
      Promise.resolve(
        Response.json({
          environmentId: ENVIRONMENT_ID,
          label: "Compatible environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: { repositoryIdentity: true },
        }),
      )) satisfies typeof fetch),
    Layer.succeed(
      ConnectionProfileStore.ConnectionProfileStore,
      ConnectionProfileStore.ConnectionProfileStore.of({
        get: () => Effect.succeedNone,
        put: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ConnectionCredentialStore.ConnectionCredentialStore,
      ConnectionCredentialStore.ConnectionCredentialStore.of({
        get: () => Effect.succeedNone,
        put: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({
        bearerToken: Effect.succeedSome(options.primaryBearerToken),
        refreshBearerToken: options.refreshBearerToken,
      }),
    ),
    Layer.succeed(
      ClientCapabilities.ClientPresentation,
      ClientCapabilities.ClientPresentation.of({
        metadata: { label: "Test Client", deviceType: "desktop", surface: "web" },
      }),
    ),
    Layer.succeed(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
        authorizeBearer: options.authorizeBearer,
        authorizeDpop: () => Effect.die("unused"),
        authorizeDpopHttp: () => Effect.die("unused"),
        renewDpopBeforeExpiry: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.SshEnvironmentGateway,
      ClientCapabilities.SshEnvironmentGateway.of({
        provision: () => Effect.die("unused"),
        prepare: () => Effect.die("unused"),
        disconnect: () => Effect.void,
      }),
    ),
  );

  return Effect.succeed(ConnectionResolver.layer.pipe(Layer.provide(layerDependencies)));
});

describe("ConnectionResolver", () => {
  it.effect("refreshes a refused primary bearer once before authorizing again", () =>
    Effect.gen(function* () {
      const tokens: string[] = [];
      const rejected: string[] = [];
      const layerBroker = yield* makeDependencies({
        primaryBearerToken: "revoked",
        refreshBearerToken: (token) =>
          Effect.sync(() => {
            rejected.push(token);
            return Option.some("fresh");
          }),
        authorizeBearer: (input) => {
          tokens.push(input.bearerToken);
          if (input.bearerToken === "revoked")
            return Effect.fail(
              new ConnectionBlockedError({ reason: "authentication", detail: "Revoked" }),
            );
          return Effect.succeed({
            environmentId: input.expectedEnvironmentId,
            label: "Primary",
            httpBaseUrl: input.httpBaseUrl,
            socketUrl: "ws://127.0.0.1:3777/ws",
            httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
          });
        },
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });
      expect(yield* broker.prepare(catalogEntry(target))).toMatchObject({
        httpAuthorization: { token: "fresh" },
      });
      expect(tokens).toEqual(["revoked", "fresh"]);
      expect(rejected).toEqual(["revoked"]);
    }),
  );

  it.effect(
    "does not loop on a second auth refusal or refresh for an incompatible environment",
    () =>
      Effect.gen(function* () {
        for (const reason of ["authentication", "configuration"] as const) {
          const tokens: string[] = [];
          const refreshed: string[] = [];
          const layerBroker = yield* makeDependencies({
            primaryBearerToken: "revoked",
            refreshBearerToken: (token) =>
              Effect.sync(() => {
                refreshed.push(token);
                return Option.some("fresh");
              }),
            authorizeBearer: (input) => {
              tokens.push(input.bearerToken);
              return Effect.fail(new ConnectionBlockedError({ reason, detail: "Refused" }));
            },
          });
          const broker = yield* ConnectionResolver.ConnectionResolver.pipe(
            Effect.provide(layerBroker),
          );
          const target = new PrimaryConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "Primary",
            httpBaseUrl: "http://127.0.0.1:3777",
            wsBaseUrl: "ws://127.0.0.1:3777",
          });
          const error = yield* broker.prepare(catalogEntry(target)).pipe(Effect.flip);
          expect(error._tag).toBe("ConnectionBlockedError");
          expect(tokens).toEqual(reason === "authentication" ? ["revoked", "fresh"] : ["revoked"]);
          expect(refreshed).toEqual(reason === "authentication" ? ["revoked"] : []);
        }
      }),
  );
});
