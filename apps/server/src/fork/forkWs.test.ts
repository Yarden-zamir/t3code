import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { environmentLabelUpdates } from "./forkWs.ts";
import * as KitshnGrants from "./kitshn/KitshnGrants.ts";

const environment = {
  environmentId: EnvironmentId.make("environment:fork-ws"),
  label: "Mac",
  platform: { os: "darwin" as const, arch: "arm64" as const },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: false },
};

describe("environmentLabelUpdates", () => {
  it.effect("sends a snapshot when kitshn links a new peer origin", () =>
    Effect.gen(function* () {
      const origins = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
      const layer = Layer.mergeAll(
        Layer.mock(KitshnGrants.KitshnGrants)({
          joinedMachine: Stream.make(null),
          trustsPeerOrigin: (origin) => SubscriptionRef.getUnsafe(origins).includes(origin),
          peerOrigins: () => SubscriptionRef.getUnsafe(origins),
          peerOriginChanges: SubscriptionRef.changes(origins),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({ streamChanges: Stream.never }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed(environment),
        }),
      );
      const loadConfig = Effect.sync(() => SubscriptionRef.getUnsafe(origins));
      const next = yield* environmentLabelUpdates(loadConfig, { environment }).pipe(
        Stream.runHead,
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(origins, ["https://vps.example.com"]);
      const snapshot = Option.getOrNull(yield* Fiber.join(next));
      expect(snapshot?.config).toEqual(["https://vps.example.com"]);
    }),
  );
});
