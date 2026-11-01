import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/http";

import * as ServerConfig from "./config.ts";
import * as KitshnGrants from "./fork/kitshn/KitshnGrants.ts";
import * as ServerHttp from "./http.ts";

describe("browser API CORS for kitshn peers", () => {
  const preflight = async (
    peerOrigins: ReadonlyArray<string> | undefined,
    origin: string,
  ): Promise<Response> => {
    const layerRoute = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
      }),
    );
    const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "http-cors-trust-" });
    const layerGrants =
      peerOrigins === undefined
        ? Layer.empty
        : Layer.mock(KitshnGrants.KitshnGrants)({
            trustsPeerOrigin: (candidate) => peerOrigins.includes(candidate),
            peerOrigins: () => peerOrigins,
          });
    const layerApp = Layer.merge(layerRoute, ServerHttp.layerBrowserApiCors).pipe(
      Layer.provide(layerConfig),
      Layer.provide(layerGrants),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });
    try {
      return await handler(
        new Request("https://t3-vps.example.com/api/environment", {
          method: "OPTIONS",
          headers: { origin, "access-control-request-method": "GET" },
        }),
      );
    } finally {
      await dispose();
    }
  };

  it("keeps the wildcard without credentials without kitshn", async () => {
    const response = await preflight(undefined, "https://t3-mac.example.com");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("answers a kitshn peer with its exact origin and credentials", async () => {
    const response = await preflight(
      ["https://t3-mac.example.com", "https://t3-win.example.com"],
      "https://t3-mac.example.com",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("https://t3-mac.example.com");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("gives another origin the wildcard without credentials", async () => {
    const response = await preflight(["https://t3-mac.example.com"], "https://evil.example.com");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
