import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  ConnectionTransientError,
  RelayConnectionTarget,
  type ConnectionAttemptError,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import { syncTimings } from "../fork/syncTimings.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
});

const RELAY_ENTRY: ConnectionCatalogEntry = {
  target: RELAY_TARGET,
  profile: Option.none(),
  enabled: true,
};

const PREPARED: PreparedConnection = {
  environmentId: RELAY_TARGET.environmentId,
  label: RELAY_TARGET.label,
  httpBaseUrl: "https://environment.example.test",
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: RELAY_TARGET,
};

const PROBE_CAPABLE_CONFIG = {
  environment: { capabilities: { connectionProbe: true } },
} as ServerConfig;

/** Session 1 is the socket that was open while the app was in the background. */
const makeHarness = Effect.fn("TestReplacementHarness.make")(function* (
  probe: (session: number) => Effect.Effect<void, ConnectionAttemptError>,
  replacementConnectsAfter: Duration.Input = 0,
) {
  const sessionCount = yield* Ref.make(0);
  const released = yield* Ref.make<ReadonlyArray<number>>([]);
  const firstSessionClosed = yield* Deferred.make<never, ConnectionTransientError>();
  const wakeups = yield* SubscriptionRef.make({
    sequence: 0,
    reason: "application-active" as ConnectionWakeups.ConnectionWakeup,
  });
  const connect: ConnectionDriver.ConnectionDriver["Service"]["connect"] = (_entry, report) =>
    Effect.gen(function* () {
      yield* report({ stage: "opening", prepared: PREPARED });
      const session = yield* Ref.updateAndGet(sessionCount, (count) => count + 1);
      yield* Effect.acquireRelease(Effect.void, () =>
        Ref.update(released, (all) => [...all, session]),
      );
      if (session > 1) yield* Effect.sleep(replacementConnectsAfter);
      return {
        prepared: PREPARED,
        session: {
          client: {} as WsRpcProtocolClient,
          initialConfig: Effect.succeed(PROBE_CAPABLE_CONFIG),
          subscribeServerConfig: () => Stream.empty,
          ready: Effect.void,
          probe: probe(session),
          inboundFrames: Effect.succeed(0),
          closed: session === 1 ? Deferred.await(firstSessionClosed) : Effect.never,
        } satisfies RpcSession.RpcSession,
      };
    });
  const dependencies = Layer.mergeAll(
    Layer.succeed(Random.Random, {
      nextDoubleUnsafe: () => 1 - Number.EPSILON,
      nextIntUnsafe: () => 0,
    }),
    Layer.succeed(Connectivity.Connectivity, {
      status: Effect.succeed<NetworkStatus>("online"),
      changes: Stream.never,
    }),
    Layer.succeed(ConnectionWakeups.ConnectionWakeups, {
      changes: SubscriptionRef.changes(wakeups).pipe(
        Stream.drop(1),
        Stream.map((event) => event.reason),
      ),
    }),
    Layer.succeed(ConnectionDriver.ConnectionDriver, {
      connect,
      preflight: () => Effect.succeed(false),
      checkHost: () => Effect.succeed("answered"),
    }),
  );
  const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
    initiallyDesired: true,
  }).pipe(Effect.provide(dependencies));
  const stateWhere = (predicate: (state: SupervisorConnectionState) => boolean) =>
    SubscriptionRef.changes(supervisor.state).pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  yield* stateWhere((state) => state.phase === "connected");
  const wake = (reason: ConnectionWakeups.ConnectionWakeup) =>
    SubscriptionRef.update(wakeups, (event) => ({ sequence: event.sequence + 1, reason }));
  const closeFirstSession = Deferred.fail(
    firstSessionClosed,
    new ConnectionTransientError({ reason: "network", detail: "Session closed." }),
  );
  return { supervisor, sessionCount, released, stateWhere, wake, closeFirstSession };
});

describe("EnvironmentSupervisor long resume replacement", () => {
  it.effect("opens a new socket at once and keeps the old one until the old one is dead", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness((session) => (session === 1 ? Effect.never : Effect.void));

      yield* h.wake("application-active-long");
      yield* TestClock.adjust("1 millis");
      expect(yield* Ref.get(h.sessionCount)).toBe(2);
      expect(yield* Ref.get(h.released)).toEqual([]);
      expect((yield* SubscriptionRef.get(h.supervisor.session)).pipe(Option.isSome)).toBe(true);
      expect((yield* SubscriptionRef.get(h.supervisor.state)).generation).toBe(1);

      // A remote socket counts as dead after 2.5 seconds without a frame.
      yield* TestClock.adjust("2500 millis");
      yield* h.stateWhere((state) => state.phase === "connected" && state.generation === 2);
      expect(yield* Ref.get(h.released)).toEqual([1]);
      expect(yield* Ref.get(h.sessionCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("adopts the new socket when the old one closes after the new one connects", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness((session) => (session === 1 ? Effect.never : Effect.void));

      yield* h.wake("application-active-long");
      yield* TestClock.adjust("1 millis");
      expect(yield* Ref.get(h.sessionCount)).toBe(2);
      yield* h.closeFirstSession;
      yield* TestClock.adjust("20 seconds");

      yield* h.stateWhere((state) => state.phase === "connected" && state.generation === 2);
      expect(yield* Ref.get(h.sessionCount)).toBe(2);
      expect(yield* Ref.get(h.released)).toEqual([1]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "leaves connected at once and honors a disconnect while it waits for the new socket",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(
          (session) => (session === 1 ? Effect.never : Effect.void),
          "10 seconds",
        );

        yield* h.wake("application-active-long");
        yield* TestClock.adjust("1 millis");
        yield* h.closeFirstSession;
        yield* h.stateWhere((state) => state.phase === "connecting");
        expect(Option.isNone(yield* SubscriptionRef.get(h.supervisor.session))).toBe(true);

        yield* h.supervisor.disconnect;
        yield* TestClock.adjust("1 second");
        yield* h.stateWhere((state) => state.phase === "available" && !state.desired);
        expect([...(yield* Ref.get(h.released))].sort()).toEqual([1, 2]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("closes the new socket when the old one answers the probe", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness((session) =>
        session === 1 ? Effect.sleep("200 millis") : Effect.void,
      );

      yield* h.wake("application-active-long");
      yield* TestClock.adjust("1 millis");
      expect(yield* Ref.get(h.sessionCount)).toBe(2);

      yield* TestClock.adjust("200 millis");
      yield* TestClock.adjust("5 seconds");
      expect(yield* Ref.get(h.released)).toEqual([2]);
      expect(yield* SubscriptionRef.get(h.supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("records only the probes of a return to the foreground in the sync timings", () =>
    Effect.gen(function* () {
      syncTimings.enable();
      const h = yield* makeHarness(() => Effect.void);
      const probes = () =>
        Effect.sync(() => {
          const { coldStart, wakeups } = syncTimings.snapshot();
          return (wakeups[0] ?? coldStart).environments.get(RELAY_TARGET.environmentId)?.probes;
        });

      yield* h.wake("network-changed");
      yield* TestClock.adjust("1 second");
      expect(yield* probes()).toBeUndefined();

      syncTimings.leftForeground();
      syncTimings.startRun("application-active-probe");
      yield* h.wake("application-active-probe");
      yield* TestClock.adjust("1 second");
      expect((yield* probes())?.map((probe) => probe.result)).toEqual(["alive"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("opens no new socket for a short background", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness((session) => (session === 1 ? Effect.never : Effect.void));

      yield* h.wake("application-active-probe");
      yield* TestClock.adjust("2499 millis");
      expect(yield* Ref.get(h.sessionCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
