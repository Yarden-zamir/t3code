import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { EnvironmentThreadStatus } from "../state/threadState.ts";
import { makeThreadSyncActivity } from "./threadSyncActivity.ts";

const ENVIRONMENT = EnvironmentId.make("environment-1");
const OTHER_ENVIRONMENT = EnvironmentId.make("environment-2");

const threadState = (status: EnvironmentThreadStatus) =>
  SubscriptionRef.make<{ readonly status: EnvironmentThreadStatus }>({ status });

describe("threadSyncActivity", () => {
  it.effect("waits until no followed thread of the environment synchronizes", () => {
    const controller = new AbortController();
    return Effect.gen(function* () {
      const activity = makeThreadSyncActivity();
      const open = yield* threadState("cached");
      const warm = yield* threadState("synchronizing");
      const other = yield* threadState("synchronizing");
      const warmScope = yield* Scope.make();
      yield* activity.follow(ENVIRONMENT, open);
      yield* activity.follow(ENVIRONMENT, warm).pipe(Scope.provide(warmScope));
      yield* activity.follow(OTHER_ENVIRONMENT, other);
      yield* SubscriptionRef.set(open, { status: "synchronizing" as EnvironmentThreadStatus });
      let idle = false;
      void activity
        .whenNoThreadSynchronizes(ENVIRONMENT, controller.signal)
        .then(() => (idle = true));
      const flush = Effect.promise(() => Promise.resolve());

      yield* SubscriptionRef.set(open, { status: "live" as EnvironmentThreadStatus });
      yield* flush;
      expect(idle).toBe(false);

      // A thread of another environment that still synchronizes does not hold it.
      yield* Scope.close(warmScope, Exit.void);
      yield* flush;
      expect(idle).toBe(true);
    }).pipe(Effect.scoped);
  });

  it.effect("ends the wait on abort", () => {
    const controller = new AbortController();
    return Effect.gen(function* () {
      const activity = makeThreadSyncActivity();
      yield* activity.follow(ENVIRONMENT, yield* threadState("synchronizing"));
      const wait = activity.whenNoThreadSynchronizes(ENVIRONMENT, controller.signal);

      controller.abort();
      yield* Effect.promise(() => wait);
    }).pipe(Effect.scoped);
  });
});
