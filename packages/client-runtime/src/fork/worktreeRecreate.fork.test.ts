import { FORK_LOST_WORKTREE_FAILURE_CODE, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { worktreeRecreateRunId } from "./worktreeRecreate.ts";

const failed = { id: RunId.make("run-1"), status: "failed", ordinal: 1 } as const;
const error = (code: string) =>
  ({
    runId: failed.id,
    failure: { class: "provider_error", message: "gone", code, retryable: null },
  }) as const;

describe("worktreeRecreateRunId", () => {
  it("offers the resend only for the latest run that failed to restore its worktree", () => {
    expect(worktreeRecreateRunId([failed], error(FORK_LOST_WORKTREE_FAILURE_CODE))).toBe(failed.id);
    const resent = { id: RunId.make("run-2"), status: "queued", ordinal: 2 } as const;
    expect(
      worktreeRecreateRunId([failed, resent], error(FORK_LOST_WORKTREE_FAILURE_CODE)),
    ).toBeNull();
    expect(worktreeRecreateRunId([failed], error("provider_crashed"))).toBeNull();
    expect(
      worktreeRecreateRunId(
        [{ ...failed, status: "completed" }],
        error(FORK_LOST_WORKTREE_FAILURE_CODE),
      ),
    ).toBeNull();
  });
});
