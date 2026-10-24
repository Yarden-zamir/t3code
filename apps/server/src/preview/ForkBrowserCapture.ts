// @effect-diagnostics nodeBuiltinImport:off - Correlates native rendering leases across server restarts.
import type {
  ForkBrowserCaptureCommand,
  ForkBrowserCaptureReport,
} from "@t3tools/contracts/forkBrowserCapture";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as NodeCrypto from "node:crypto";

import type { DesktopTabKey } from "./DesktopBrowserChannel.ts";
import { ServerBrowserOperationError, toOperationError } from "./ServerBrowserPage.ts";

const keyOf = (key: DesktopTabKey) => `${key.threadId}\u0000${key.tabId}`;

// Fork: keep native visibility separate from the temporary activity needed to take a snapshot.
export const makeForkBrowserCapture = (
  command: (command: ForkBrowserCaptureCommand) => Effect.Effect<void>,
) => {
  const presented = new Set<string>();
  const pending = new Map<string, { key: string; ready: Deferred.Deferred<void> }>();
  return {
    visible: (key: DesktopTabKey, viewers: number) => viewers > 0 || presented.has(keyOf(key)),
    report: (event: ForkBrowserCaptureReport) => {
      const key = keyOf(event);
      if (event.type === "presentation") {
        if (event.visible) presented.add(key);
        else presented.delete(key);
      } else {
        const request = pending.get(event.requestId);
        if (request?.key === key) Deferred.doneUnsafe(request.ready, Effect.void);
      }
    },
    detach: (key: DesktopTabKey) => presented.delete(keyOf(key)),
    acquire: Effect.fn("DesktopBrowserChannel.capture")(function* (key: DesktopTabKey) {
      const requestId = NodeCrypto.randomUUID();
      const ready = yield* Deferred.make<void>();
      yield* Effect.acquireRelease(
        Effect.sync(() => pending.set(requestId, { key: keyOf(key), ready })),
        () =>
          command({ type: "capture", ...key, requestId, active: false }).pipe(
            Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
          ),
      );
      yield* command({ type: "capture", ...key, requestId, active: true });
      yield* Deferred.await(ready).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () =>
            Effect.fail(
              new ServerBrowserOperationError(
                "PreviewAutomationTimeoutError",
                "Snapshot rendering placement timed out after 2000ms.",
                { stage: "rendering placement", timeoutMs: 2_000 },
              ),
            ),
        }),
      );
    }),
  };
};

/** Fork: Promise adapter for ServerBrowser's Playwright operations, without wrapping their errors. */
export const withForkBrowserCapture = async <A>(
  capture: ReturnType<typeof makeForkBrowserCapture>,
  key: DesktopTabKey,
  native: boolean,
  run: () => Promise<A>,
): Promise<A> => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        if (native) yield* capture.acquire(key);
        return yield* Effect.tryPromise({ try: run, catch: toOperationError });
      }),
    ).pipe(Effect.result),
  );
  if (result._tag === "Failure") throw result.failure;
  return result.success;
};
