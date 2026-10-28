import {
  FORK_LOST_WORKTREE_FAILURE_CODE,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";

/**
 * The run that "Recreate on a new branch" resends, for a lost worktree failure row. Only the
 * thread's latest run offers it: the resend starts a newer run, which retires the button.
 */
export function worktreeRecreateRunId(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "ordinal">>,
  error: Pick<Extract<OrchestrationV2TurnItem, { readonly type: "error" }>, "runId" | "failure">,
): RunId | null {
  if (error.failure.code !== FORK_LOST_WORKTREE_FAILURE_CODE || error.runId === null) return null;
  const run = runs.find((candidate) => candidate.id === error.runId);
  if (run?.status !== "failed") return null;
  return runs.some((candidate) => candidate.ordinal > run.ordinal) ? null : run.id;
}
