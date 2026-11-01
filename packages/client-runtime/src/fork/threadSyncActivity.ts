import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { EnvironmentThreadStatus } from "../state/threadState.ts";
import { type SyncTimingMark, syncTimings } from "./syncTimings.ts";

/**
 * Counts the thread states that synchronize per environment, so that background work for an
 * environment can wait for them.
 */
export function makeThreadSyncActivity() {
  const synchronizing = new Map<EnvironmentId, number>();
  const idleWaiters = new Map<EnvironmentId, Set<() => void>>();
  const change = (environmentId: EnvironmentId, delta: 1 | -1) => {
    const count = (synchronizing.get(environmentId) ?? 0) + delta;
    if (count > 0) {
      synchronizing.set(environmentId, count);
      return;
    }
    synchronizing.delete(environmentId);
    const waiters = idleWaiters.get(environmentId);
    idleWaiters.delete(environmentId);
    for (const resolve of waiters ?? []) resolve();
  };

  const follow = Effect.fn("ThreadSyncActivity.follow")(function* <
    S extends { readonly status: EnvironmentThreadStatus },
  >(
    environmentId: EnvironmentId,
    state: SubscriptionRef.SubscriptionRef<S>,
  ): Effect.fn.Return<void, never, Scope.Scope> {
    let counted = false;
    const track = (status: EnvironmentThreadStatus) => {
      if ((status === "synchronizing") === counted) return;
      counted = !counted;
      change(environmentId, counted ? 1 : -1);
    };
    yield* Effect.addFinalizer(() => Effect.sync(() => counted && change(environmentId, -1)));
    track((yield* SubscriptionRef.get(state)).status);
    yield* SubscriptionRef.changes(state).pipe(
      Stream.runForEach((value) => Effect.sync(() => track(value.status))),
      Effect.forkScoped({ startImmediately: true }),
    );
  });

  /** Resolves once no followed thread state of the environment synchronizes, or on abort. */
  const whenNoThreadSynchronizes = (environmentId: EnvironmentId, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (!synchronizing.has(environmentId) || signal.aborted) return resolve();
      const waiters = idleWaiters.get(environmentId) ?? new Set<() => void>();
      idleWaiters.set(environmentId, waiters);
      const done = () => {
        waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      waiters.add(done);
      signal.addEventListener("abort", done);
    });

  return { follow, whenNoThreadSynchronizes };
}

export const threadSyncActivity = makeThreadSyncActivity();

const THREAD_TIMING_MARKS: Partial<Record<EnvironmentThreadStatus, SyncTimingMark>> = {
  synchronizing: "threadSynchronizing",
  live: "threadLive",
};

const warmingThreads = new Set<string>();
const threadKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\u0000${threadId}`;

/**
 * Keeps a background mount of a thread out of the open thread timings until the result is
 * called. A user who opens that thread meanwhile gets no open thread marks for it.
 */
export const markWarmingThread = (environmentId: EnvironmentId, threadId: ThreadId) => {
  const key = threadKey(environmentId, threadId);
  warmingThreads.add(key);
  return () => {
    warmingThreads.delete(key);
  };
};

/** Follows a thread state for the sync activity, and for the sync timings when they record. */
export const followThreadSync = <S extends { readonly status: EnvironmentThreadStatus }>(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  state: SubscriptionRef.SubscriptionRef<S>,
): Effect.Effect<void, never, Scope.Scope> => {
  const key = threadKey(environmentId, threadId);
  return threadSyncActivity
    .follow(environmentId, state)
    .pipe(
      Effect.andThen(
        syncTimings.followStatus<S>(
          environmentId,
          state,
          THREAD_TIMING_MARKS,
          () => !warmingThreads.has(key),
        ),
      ),
    );
};
