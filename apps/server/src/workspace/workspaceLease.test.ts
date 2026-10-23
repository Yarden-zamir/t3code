import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { withWorkspaceLease } from "./workspaceLease.ts";

it.effect("the lease holder takes the same lease again without waiting", () =>
  Effect.gen(function* () {
    const result = yield* withWorkspaceLease(
      "/lease/reentry",
      withWorkspaceLease("/lease/reentry", Effect.succeed("nested")),
    );
    assert.strictEqual(result, "nested");
  }),
);

it.effect("a fiber that outlives its lease waits for the next holder", () =>
  Effect.gen(function* () {
    const stale = yield* withWorkspaceLease("/lease/stale", Effect.context<never>());
    const attempt = yield* withWorkspaceLease(
      "/lease/stale",
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          withWorkspaceLease("/lease/stale", Effect.succeed("entered")).pipe(
            Effect.timeoutOption("1 second"),
            Effect.provideContext(stale),
          ),
        );
        yield* TestClock.adjust("1 second");
        return yield* Fiber.join(fiber);
      }),
    );
    assert.isTrue(Option.isNone(attempt));
  }),
);
