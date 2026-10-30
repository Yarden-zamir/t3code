import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { makeEnvironmentShellState } from "./shell.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
import { v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const SNAPSHOT: OrchestrationV2ShellSnapshot = { ...v2ShellSnapshot, snapshotSequence: 1 };

const familiesConfig = (enabled: boolean) =>
  ({
    shellResumeCompletionMarker: true,
    shellThreadFamilies: enabled,
    shellOlderSettled: enabled,
  }) as ServerConfig;

const makeHarness = Effect.fn("test.makeEarlyShellSnapshotHarness")(function* (input: {
  readonly cachedConfig: Option.Option<ServerConfig>;
  readonly socketConfig: ServerConfig;
  /** The first load answers only when interrupted, like a slow server. */
  readonly holdFirstLoad?: boolean;
}) {
  const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
  const subscribeInput = yield* Deferred.make<unknown>();
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (subscribe: unknown) =>
      Stream.unwrap(
        Deferred.succeed(subscribeInput, subscribe).pipe(Effect.as(Stream.fromQueue(events))),
      ),
  } as unknown as WsRpcProtocolClient;
  const socketSession: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed(input.socketConfig),
    subscribeServerConfig: (subscribe) => client.subscribeServerConfig(subscribe),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const session = yield* SubscriptionRef.make(Option.none<RpcSession.RpcSession>());
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session,
    prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(input.cachedConfig),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const loads = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const firstLoad = yield* Deferred.make<void>();
  const firstLoadInterrupted = yield* Ref.make(false);
  const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
    load: (_prepared, options) =>
      Ref.getAndUpdate(loads, (all) => [...all, options]).pipe(
        Effect.tap(() => Deferred.succeed(firstLoad, undefined)),
        Effect.flatMap((before) =>
          before.length === 0 && input.holdFirstLoad === true
            ? Effect.never.pipe(Effect.onInterrupt(() => Ref.set(firstLoadInterrupted, true)))
            : Effect.succeedSome(SNAPSHOT),
        ),
      ),
  });
  yield* makeEnvironmentShellState().pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
  );
  const openSocket = SubscriptionRef.set(session, Option.some(socketSession));
  return { loads, firstLoad, firstLoadInterrupted, subscribeInput, openSocket };
});

describe("early environment shell snapshot", () => {
  it.effect("loads the HTTP snapshot while the socket opens and uses it once", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        cachedConfig: Option.some(familiesConfig(true)),
        socketConfig: familiesConfig(true),
      });

      yield* Deferred.await(h.firstLoad);
      yield* h.openSocket;

      expect(yield* Deferred.await(h.subscribeInput)).toMatchObject({ afterSequence: 1 });
      expect(yield* Ref.get(h.loads)).toEqual([
        { omitIdleSubagents: true, omitOlderSettled: true },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("loads the snapshot again when the socket config changes the omissions", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        cachedConfig: Option.some(familiesConfig(false)),
        socketConfig: familiesConfig(true),
        holdFirstLoad: true,
      });

      yield* Deferred.await(h.firstLoad);
      yield* h.openSocket;

      expect(yield* Deferred.await(h.subscribeInput)).toMatchObject({
        afterSequence: 1,
        omitIdleSubagents: true,
      });
      expect(yield* Ref.get(h.loads)).toEqual([
        { omitIdleSubagents: false, omitOlderSettled: false },
        { omitIdleSubagents: true, omitOlderSettled: true },
      ]);
      expect(yield* Ref.get(h.firstLoadInterrupted)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("waits for the socket without a cached server config", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        cachedConfig: Option.none(),
        socketConfig: familiesConfig(false),
      });

      expect(yield* Ref.get(h.loads)).toEqual([]);
      yield* h.openSocket;

      expect(yield* Deferred.await(h.subscribeInput)).toMatchObject({ afterSequence: 1 });
      expect(yield* Ref.get(h.loads)).toEqual([
        { omitIdleSubagents: false, omitOlderSettled: false },
      ]);
    }).pipe(Effect.scoped),
  );
});
