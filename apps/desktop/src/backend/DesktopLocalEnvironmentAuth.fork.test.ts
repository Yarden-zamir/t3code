import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";

const config = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "desktop-bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

describe("DesktopLocalEnvironmentAuth", () => {
  const tokenResponse = (request: HttpClientRequest.HttpClientRequest) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify({
          access_token: "desktop-bearer-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "orchestration:read",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  const layerPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
    list: Effect.succeed([
      {
        id: PRIMARY_LOCAL_ENVIRONMENT_ID,
        label: Effect.succeed("Windows"),
        currentConfig: Effect.succeedSome(config),
      },
    ]),
  } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
  const makeExchange = (failures: number, failure: () => Response) =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const layerHttpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.updateAndGet(requestCount, (count) => count + 1).pipe(
            Effect.map((count) =>
              count <= failures
                ? HttpClientResponse.fromWeb(request, failure())
                : tokenResponse(request),
            ),
          ),
        ),
      );
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
        Effect.provide(
          DesktopLocalEnvironmentAuth.layer.pipe(
            Layer.provide(Layer.mergeAll(layerPool, layerHttpClient)),
          ),
        ),
      );
      return { auth, requestCount };
    });

  it.effect("renews before expiry and exchanges a revoked token again", () =>
    Effect.gen(function* () {
      const { auth, requestCount } = yield* makeExchange(0, () => new Response());
      yield* auth.getBearerToken;
      yield* TestClock.adjust(Duration.seconds(3540));
      yield* auth.getBearerToken;
      assert.strictEqual(yield* Ref.get(requestCount), 2);
      yield* auth.invalidateBearerToken("different-token");
      yield* auth.getBearerToken;
      assert.strictEqual(yield* Ref.get(requestCount), 2);
      yield* auth.invalidateBearerToken("desktop-bearer-token");
      yield* auth.getBearerToken;
      assert.strictEqual(yield* Ref.get(requestCount), 3);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
