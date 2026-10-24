import type { ForkSnapshotStage } from "@t3tools/contracts/forkBrowserCapture";

import type { ServerBrowserOperationError } from "./ServerBrowserPage.ts";

// Fork: report the inner capture deadline, not the broker's larger transport budget.
export const makeForkSnapshotProgress = (
  timeoutMs: number,
  OperationError: typeof ServerBrowserOperationError,
) => {
  const pending = new Set<ForkSnapshotStage>();
  const timeout = (stage = pending.values().next().value ?? "password fields") =>
    new OperationError(
      "PreviewAutomationTimeoutError",
      `Snapshot ${stage} timed out after ${timeoutMs}ms. Wait for the page to settle and take another snapshot.`,
      { timeoutMs, stage },
    );
  return {
    timeout,
    track: async <A>(stage: ForkSnapshotStage, run: () => Promise<A>): Promise<A> => {
      pending.add(stage);
      try {
        return await run();
      } catch (cause) {
        if (cause instanceof Error && cause.name === "TimeoutError") throw timeout(stage);
        throw cause;
      } finally {
        pending.delete(stage);
      }
    },
  };
};
