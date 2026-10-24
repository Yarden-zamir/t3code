import {
  EnvironmentId,
  type MachineMapReadableEnvironment,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createReadableThreadEnvironmentAtoms } from "./readableThreadEnvironments.ts";

const SELF = EnvironmentId.make("environment:mac");
const PEER = EnvironmentId.make("environment:vps");
const TARGET = new PrimaryConnectionTarget({
  environmentId: SELF,
  label: "Mac",
  httpBaseUrl: "https://mac.example.test",
  wsBaseUrl: "wss://mac.example.test",
});

it.effect("a send waits for the readable machines instead of reading only its own", () =>
  Effect.gen(function* () {
    const answer = yield* Deferred.make<ReadonlyArray<MachineMapReadableEnvironment>>();
    const client = {
      [WS_METHODS.machineMapReadableEnvironments]: () => Deferred.await(answer),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      initialConfig: Effect.succeed({} as ServerConfig),
      subscribeServerConfig: () => Stream.never,
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
      }),
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const environments = EnvironmentRegistry.EnvironmentRegistry.of({
      run: (_environmentId, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      followStream: (_environmentId, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const atoms = createReadableThreadEnvironmentAtoms(
      Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments)),
    );
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
      Effect.sync(() => registry.dispose()),
    );

    const loading = atoms.loadReadableIds(registry, SELF);
    // Before the answer, the composer's own environment is all that the sync check sees.
    expect(registry.get(atoms.readableIds(SELF))).toEqual([SELF]);
    yield* Deferred.succeed(answer, [
      { environmentId: SELF, name: "Mac" },
      { environmentId: PEER, name: "VPS" },
    ]);
    expect(yield* Effect.promise(() => loading)).toEqual([SELF, PEER]);
  }),
);
