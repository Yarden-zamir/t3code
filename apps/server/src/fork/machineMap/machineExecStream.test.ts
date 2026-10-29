import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { makeLiveness, PING_INTERVAL } from "./machineExecStream.ts";

it.effect("keepalive: a stream past 100 seconds stays open while the other end answers", () =>
  Effect.gen(function* () {
    const liveness = yield* makeLiveness;
    let pings = 0;
    // The other end answers each ping, as the frames of a quiet command do through Cloudflare.
    const answered = Effect.sync(() => {
      pings += 1;
    }).pipe(Effect.andThen(liveness.touch));
    const watching = yield* liveness.watch(answered).pipe(Effect.forkChild);
    yield* TestClock.adjust("150 seconds");
    expect(pings).toBe(6);
    expect(watching.pollUnsafe()).toBeUndefined();
    yield* Fiber.interrupt(watching);
  }),
);

it.effect("keepalive: silence ends the stream, but not while this end waits for itself", () =>
  Effect.gen(function* () {
    const silent = yield* makeLiveness;
    const watchingSilent = yield* silent.watch(Effect.void).pipe(Effect.forkChild);
    yield* TestClock.adjust(PING_INTERVAL);
    expect(watchingSilent.pollUnsafe()).toBeUndefined();
    // The first check after 90 silent seconds ends it.
    yield* TestClock.adjust("75 seconds");
    expect(watchingSilent.pollUnsafe()).toBeDefined();

    const waiting = yield* makeLiveness;
    // A command that does not read its stdin holds the other end's frames here.
    yield* waiting.whileWaitingHere(Effect.never).pipe(Effect.forkChild);
    const watchingWaiting = yield* waiting.watch(Effect.void).pipe(Effect.forkChild);
    yield* TestClock.adjust("10 minutes");
    expect(watchingWaiting.pollUnsafe()).toBeUndefined();
    yield* Fiber.interrupt(watchingWaiting);
  }),
);
