import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import { awaitHandover } from "./portalTunnelFile.ts";

it.effect("retires the portal tunnel only after kitshn held the host for 10 minutes", () =>
  Effect.gen(function* () {
    const withKitshn = yield* SubscriptionRef.make(false);
    const waiting = yield* awaitHandover(SubscriptionRef.changes(withKitshn)).pipe(
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 hour");
    expect(waiting.pollUnsafe()).toBeUndefined();
    // A give-back before the 10 minutes end keeps the portal tunnel running.
    yield* SubscriptionRef.set(withKitshn, true);
    yield* TestClock.adjust("5 minutes");
    yield* SubscriptionRef.set(withKitshn, false);
    yield* TestClock.adjust("10 minutes");
    expect(waiting.pollUnsafe()).toBeUndefined();
    yield* SubscriptionRef.set(withKitshn, true);
    yield* TestClock.adjust("10 minutes");
    yield* Fiber.join(waiting);
  }),
);
