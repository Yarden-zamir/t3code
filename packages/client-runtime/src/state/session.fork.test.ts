import { assert, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import { RemoteEnvironmentAuthTimeoutError } from "../rpc/http.ts";
import { retryTransientSessionFailures } from "./session.ts";

class EnvironmentAuthInvalidError extends Data.TaggedError("EnvironmentAuthInvalidError")<{}> {}

const failingTimes = (failures: number, error: () => { readonly _tag: string }) => {
  let attempts = 0;
  const effect = Effect.suspend(() => {
    attempts += 1;
    return attempts <= failures ? Effect.fail(error()) : Effect.succeed("session");
  });
  return { effect, attempts: () => attempts };
};

it.effect("a session request that timed out is tried again", () =>
  Effect.gen(function* () {
    const request = failingTimes(
      2,
      () => new RemoteEnvironmentAuthTimeoutError("http://localhost/api/auth/session", 6_000),
    );
    const fiber = yield* Effect.forkChild(retryTransientSessionFailures(request.effect));
    yield* TestClock.adjust("10 seconds");
    assert.equal(yield* Fiber.join(fiber), "session");
    assert.equal(request.attempts(), 3);
  }),
);

it.effect("a rejected session is not tried again", () =>
  Effect.gen(function* () {
    const request = failingTimes(1, () => new EnvironmentAuthInvalidError());
    const result = yield* Effect.flip(retryTransientSessionFailures(request.effect));
    assert.instanceOf(result, EnvironmentAuthInvalidError);
    assert.equal(request.attempts(), 1);
  }),
);
