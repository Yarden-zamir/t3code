import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { markWarmingThread } from "../fork/threadSyncActivity.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { EMPTY_THREAD_HISTORY_META } from "./threadHistoryMerge.ts";
import { makeEnvironmentThreadState } from "./threads.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("warmup-environment"),
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

describe("thread state for the cache warm-up", () => {
  it.effect("confirms a retained live thread only after its new subscription completes", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
      const subscribed = yield* Deferred.make<void>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: () =>
          Stream.unwrap(
            Deferred.succeed(subscribed, undefined).pipe(Effect.as(Stream.fromQueue(events))),
          ),
      } as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        initialConfig: Effect.succeed({} as never),
        subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
        ready: Effect.void,
        probe: Effect.void,
        inboundFrames: Effect.succeed(0),
        closed: Effect.never,
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
        }),
        session: yield* SubscriptionRef.make(Option.some(session)),
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
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      // The saved cache matches this retained state, and the server has changed since.
      const retained = {
        state: {
          data: Option.some(v2Projection),
          status: "live" as const,
          error: Option.none(),
          history: EMPTY_THREAD_HISTORY_META,
          sequence: 7,
        },
        sequence: 7,
        persisted: true,
      };
      const confirmed = yield* Deferred.make<void>();
      const doneWarming = markWarmingThread(TARGET.environmentId, v2ThreadId, () =>
        Deferred.doneUnsafe(confirmed, Effect.void),
      );
      yield* Effect.addFinalizer(() => Effect.sync(doneWarming));

      const state = yield* makeEnvironmentThreadState(v2ThreadId, {
        snapshot: retained,
        owner: undefined,
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(
          ThreadSnapshotLoader.ThreadSnapshotLoader,
          ThreadSnapshotLoader.ThreadSnapshotLoader.of({ load: () => Effect.die("unused") }),
        ),
      );
      yield* Deferred.await(subscribed);
      expect((yield* SubscriptionRef.get(state)).status).toBe("live");
      expect(yield* Deferred.isDone(confirmed)).toBe(false);

      yield* Queue.offer(events, { kind: "synchronized" });
      yield* Deferred.await(confirmed);
    }).pipe(Effect.scoped),
  );
});
