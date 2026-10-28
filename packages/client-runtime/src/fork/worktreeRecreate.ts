import {
  FORK_LOST_WORKTREE_FAILURE_CODE,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";

/**
 * The run that "Recreate on a new branch" resends, for a lost worktree failure row. Only the
 * thread's latest executed run offers it: the resend starts a newer run, which retires the button.
 */
export function worktreeRecreateRunId(
  runs: ReadonlyArray<OrchestrationV2Run>,
  error: Pick<Extract<OrchestrationV2TurnItem, { readonly type: "error" }>, "runId" | "failure">,
): RunId | null {
  if (error.failure.code !== FORK_LOST_WORKTREE_FAILURE_CODE || error.runId === null) return null;
  const latest = latestExecutedRun(runs);
  return latest?.id === error.runId && latest.status === "failed" ? latest.id : null;
}
