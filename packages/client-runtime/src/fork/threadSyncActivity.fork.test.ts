import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { EnvironmentThreadStatus } from "../state/threadState.ts";
import { makeThreadSyncActivity } from "./threadSyncActivity.ts";

describe("threadSyncActivity", () => {
  it.effect("waits until no followed thread synchronizes, also when a thread state closes", () =>
    Effect.gen(function* () {
      const activity = makeThreadSyncActivity();
      const open = yield* SubscriptionRef.make<{ readonly status: EnvironmentThreadStatus }>({
        status: "cached",
      });
      const warm = yield* SubscriptionRef.make<{ readonly status: EnvironmentThreadStatus }>({
        status: "synchronizing",
      });
      const warmScope = yield* Scope.make();
      yield* activity.follow(open);
      yield* activity.follow(warm).pipe(Scope.provide(warmScope));
      yield* SubscriptionRef.set(open, { status: "synchronizing" as EnvironmentThreadStatus });
      let idle = false;
      void activity.whenNoThreadSynchronizes().then(() => (idle = true));
      const flush = Effect.promise(() => Promise.resolve());

      yield* SubscriptionRef.set(open, { status: "live" as EnvironmentThreadStatus });
      yield* flush;
      expect(idle).toBe(false);

      yield* Scope.close(warmScope, Exit.void);
      yield* flush;
      expect(idle).toBe(true);
    }).pipe(Effect.scoped),
  );
});
