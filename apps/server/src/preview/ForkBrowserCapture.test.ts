import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { makeForkBrowserCapture, withForkBrowserCapture } from "./ForkBrowserCapture.ts";
import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";

const key = { threadId: "thread", tabId: "tab" };

describe("native browser presentation", () => {
  it("preserves the inner snapshot failure and releases its native rendering lease", async () => {
    const activity: boolean[] = [];
    const capture = makeForkBrowserCapture((command) =>
      Effect.sync(() => {
        activity.push(command.active);
        if (command.active) capture.report({ ...command, type: "captureReady" });
      }),
    );
    const failure = new ServerBrowserOperationError(
      "PreviewAutomationTimeoutError",
      "Snapshot screenshot timed out after 10000ms.",
      { timeoutMs: 10_000, stage: "screenshot" },
    );
    await expect(
      withForkBrowserCapture(capture, key, true, () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(activity).toEqual([true, false]);
  });
  it.effect("releases a lease when its renderer never acknowledges placement", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const activity: boolean[] = [];
      const capture = makeForkBrowserCapture((command) =>
        Effect.gen(function* () {
          activity.push(command.active);
          if (command.active) yield* Deferred.succeed(started, undefined);
        }),
      );
      const pending = yield* Effect.scoped(capture.acquire(key)).pipe(
        Effect.result,
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(pending);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          tag: "PreviewAutomationTimeoutError",
          detail: { timeoutMs: 2_000, stage: "rendering placement" },
        },
      });
      expect(activity).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );
  it("does not confuse capture activity with presentation, and clears on detach", () => {
    const capture = makeForkBrowserCapture(() => Effect.void);
    expect(capture.visible(key, 0)).toBe(false);
    expect(capture.visible(key, 1)).toBe(true);
    capture.report({ type: "presentation", ...key, visible: true });
    expect(capture.visible(key, 0)).toBe(true);
    capture.detach(key);
    expect(capture.visible(key, 0)).toBe(false);
  });

  it.effect.each([false, true])("releases an acknowledged capture lease (fails: %s)", (fails) =>
    Effect.gen(function* () {
      const commands: Array<{ active: boolean; requestId: string }> = [];
      const capture = makeForkBrowserCapture((command) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.active) capture.report({ ...command, type: "captureReady" });
        }),
      );
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* capture.acquire(key);
          expect(capture.visible(key, 0)).toBe(false);
          expect(commands.map((command) => command.active)).toEqual([true]);
          if (fails) return yield* Effect.fail("capture failed");
          return "captured";
        }),
      ).pipe(Effect.result);
      expect(result._tag).toBe(fails ? "Failure" : "Success");
      expect(commands.map((command) => command.active)).toEqual([true, false]);
      expect(commands[0]?.requestId).toBe(commands[1]?.requestId);
    }),
  );
});
