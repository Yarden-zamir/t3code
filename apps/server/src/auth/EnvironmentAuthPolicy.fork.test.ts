import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";

const layerEnvironmentAuthPolicy = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuthPolicy.layer.pipe(
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return {
            ...config,
            ...overrides,
          } satisfies ServerConfig.ServerConfig["Service"];
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-policy-test-" })),
      ),
    ),
  );
it.layer(NodeServices.layer)("EnvironmentAuthPolicy.layer fork", (it) => {
  it.effect("allows one-time-token pairing on a loopback desktop with tunnel pairing on", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap", "one-time-token"]);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "desktop",
          host: "127.0.0.1",
          tunnelPairingUrl: "https://t3.example.com",
        }),
      ),
    ),
  );
});
