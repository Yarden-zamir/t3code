import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  ABANDONED_AFTER,
  CHECK_INTERVAL,
  collectAbandonedTerminalDrafts,
} from "./AbandonedTerminalDrafts.ts";

const start = (unattached: Ref.Ref<ReadonlyArray<string>>, closed: Array<string>) =>
  collectAbandonedTerminalDrafts({
    unattachedScreens: Ref.get(unattached),
    threadExists: (threadId) => Effect.succeed(threadId === "thread"),
    close: (threadId) => Effect.sync(() => closed.push(threadId)),
  }).pipe(Effect.forkScoped);

it.effect("closes an abandoned draft after the grace time and never a terminal of a thread", () =>
  Effect.gen(function* () {
    const closed: Array<string> = [];
    yield* start(yield* Ref.make<ReadonlyArray<string>>(["draft", "thread"]), closed);

    yield* TestClock.adjust(CHECK_INTERVAL);
    expect(closed).toEqual([]);
    yield* TestClock.adjust(ABANDONED_AFTER);
    expect(closed).toContain("draft");
    expect(closed).not.toContain("thread");
  }).pipe(Effect.scoped),
);

it.effect("counts the grace time again after a client attached in between", () =>
  Effect.gen(function* () {
    const closed: Array<string> = [];
    const unattached = yield* Ref.make<ReadonlyArray<string>>(["draft"]);
    yield* start(unattached, closed);

    const almost = Duration.subtract(ABANDONED_AFTER, CHECK_INTERVAL);
    yield* TestClock.adjust(almost);
    yield* Ref.set(unattached, []);
    yield* TestClock.adjust(CHECK_INTERVAL);
    yield* Ref.set(unattached, ["draft"]);
    yield* TestClock.adjust(CHECK_INTERVAL);
    // Without the attach in between, the draft would be closed by now.
    yield* TestClock.adjust(almost);
    expect(closed).toEqual([]);
    yield* TestClock.adjust(CHECK_INTERVAL);
    expect(closed).toEqual(["draft"]);
  }).pipe(Effect.scoped),
);
