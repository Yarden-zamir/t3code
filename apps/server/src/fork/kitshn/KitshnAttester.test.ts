import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerConfig from "../../config.ts";
import * as KitshnAttester from "./KitshnAttester.ts";
import * as KitshnCli from "./KitshnCli.ts";

/** Registers a server on `host:4321` with a fake kitshn that answers with `failure`, if any. */
const register = (
  host: string,
  options: { failure?: KitshnCli.KitshnCliError["reason"]; devUrl?: URL } = {},
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const urls: Array<string> = [];
    const attester = yield* KitshnAttester.KitshnAttester.pipe(
      Effect.provide(
        KitshnAttester.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig.ServerConfig, { ...config, devUrl: options.devUrl }),
              Layer.mock(KitshnCli.KitshnCli)({
                setAttester: (url) =>
                  Effect.suspend(() => {
                    urls.push(url);
                    return options.failure === undefined
                      ? Effect.void
                      : Effect.fail(
                          new KitshnCli.KitshnCliError({
                            reason: options.failure,
                            message: "kitshn: not allowed",
                          }),
                        );
                  }),
              }),
            ),
          ),
        ),
      ),
    );
    yield* attester
      .register(NetAddress.inetAddressFromIpStringUnsafe(host, 4321))
      .pipe(Effect.provideService(HostProcess.Platform, "linux"));
    return urls;
  });

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "kitshn-attester-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("KitshnAttester", (it) => {
  it.effect("registers a loopback or wildcard listener on its loopback address", () =>
    Effect.gen(function* () {
      expect(yield* register("127.0.0.1")).toEqual(["http://127.0.0.1:4321/api/thread-identity"]);
      expect(yield* register("0.0.0.0")).toEqual(["http://127.0.0.1:4321/api/thread-identity"]);
      expect(yield* register("::1")).toEqual(["http://[::1]:4321/api/thread-identity"]);
    }),
  );

  it.effect.each(["attester_refused", "not_installed", "run_failed"] as const)(
    "a %s failure only logs",
    (failure) =>
      Effect.gen(function* () {
        expect(yield* register("127.0.0.1", { failure })).toHaveLength(1);
      }),
  );

  it.effect("skips a non-loopback listener and a dev server", () =>
    Effect.gen(function* () {
      expect(yield* register("100.64.0.7")).toEqual([]);
      expect(yield* register("127.0.0.1", { devUrl: new URL("http://localhost:5733") })).toEqual(
        [],
      );
    }),
  );
});
