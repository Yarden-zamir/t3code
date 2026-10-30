import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { EnvironmentThreadStatus } from "../state/threadState.ts";
import { type SyncTimingMark, syncTimings } from "./syncTimings.ts";

/** Counts the thread states that synchronize, so that background work can wait for them. */
export function makeThreadSyncActivity() {
  let synchronizing = 0;
  let idleWaiters: Array<() => void> = [];
  const change = (delta: 1 | -1) => {
    synchronizing += delta;
    if (synchronizing > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const follow = Effect.fn("ThreadSyncActivity.follow")(function* <
    S extends { readonly status: EnvironmentThreadStatus },
  >(state: SubscriptionRef.SubscriptionRef<S>): Effect.fn.Return<void, never, Scope.Scope> {
    let counted = false;
    const track = (status: EnvironmentThreadStatus) => {
      if ((status === "synchronizing") === counted) return;
      counted = !counted;
      change(counted ? 1 : -1);
    };
    yield* Effect.addFinalizer(() => Effect.sync(() => counted && change(-1)));
    track((yield* SubscriptionRef.get(state)).status);
    yield* SubscriptionRef.changes(state).pipe(
      Stream.runForEach((value) => Effect.sync(() => track(value.status))),
      Effect.forkScoped({ startImmediately: true }),
    );
  });

  /** Resolves once no followed thread state is synchronizing. */
  const whenNoThreadSynchronizes = () =>
    synchronizing === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => idleWaiters.push(resolve));

  return { follow, whenNoThreadSynchronizes };
}

export const threadSyncActivity = makeThreadSyncActivity();

const THREAD_TIMING_MARKS: Partial<Record<EnvironmentThreadStatus, SyncTimingMark>> = {
  synchronizing: "threadSynchronizing",
  live: "threadLive",
};

/** Follows a thread state for the sync activity, and for the sync timings when they record. */
export const followThreadSync = <S extends { readonly status: EnvironmentThreadStatus }>(
  environmentId: EnvironmentId,
  state: SubscriptionRef.SubscriptionRef<S>,
): Effect.Effect<void, never, Scope.Scope> =>
  threadSyncActivity
    .follow(state)
    .pipe(Effect.andThen(syncTimings.followStatus<S>(environmentId, state, THREAD_TIMING_MARKS)));
