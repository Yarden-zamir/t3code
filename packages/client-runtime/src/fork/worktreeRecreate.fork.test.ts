import {
  FORK_LOST_WORKTREE_FAILURE_CODE,
  type OrchestrationV2Run,
  RunId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { worktreeRecreateRunId } from "./worktreeRecreate.ts";

const run = (id: string, status: OrchestrationV2Run["status"], ordinal: number) =>
  ({
    id: RunId.make(id),
    status,
    ordinal,
    startedAt: null,
    completedAt: null,
  }) as unknown as OrchestrationV2Run;
const failed = run("run-1", "failed", 1);
const error = (code: string) =>
  ({
    runId: failed.id,
    failure: { class: "provider_error", message: "gone", code, retryable: null },
  }) as const;
const lost = error(FORK_LOST_WORKTREE_FAILURE_CODE);

describe("worktreeRecreateRunId", () => {
  it("offers the resend only for the latest executed run that failed to restore its worktree", () => {
    expect(worktreeRecreateRunId([failed], lost)).toBe(failed.id);
    // A message held behind the failure never ran, and neither did one the user removed.
    expect(worktreeRecreateRunId([failed, run("run-2", "queued", 2)], lost)).toBe(failed.id);
    expect(worktreeRecreateRunId([failed, run("run-2", "cancelled", 2)], lost)).toBe(failed.id);
    expect(worktreeRecreateRunId([failed, run("run-3", "starting", 3)], lost)).toBeNull();
    expect(worktreeRecreateRunId([failed], error("provider_crashed"))).toBeNull();
    expect(worktreeRecreateRunId([run("run-1", "completed", 1)], lost)).toBeNull();
  });
});
