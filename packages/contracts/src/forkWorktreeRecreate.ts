import * as Schema from "effect/Schema";

import { RunId, ThreadId } from "./baseSchemas.ts";

/** Fork: the failure code of a run whose saved worktree folder is gone and was not restored. */
export const FORK_LOST_WORKTREE_FAILURE_CODE = "worktree_lost";

/**
 * Fork: moves a thread whose worktree folder is gone to a new worktree, then resends `runId` as
 * the user who clicked, from this client. A client message starts ahead of a held queue.
 */
export const ForkRecreateThreadWorktreeInput = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  creationSource: Schema.Literals(["web", "mobile"]),
});
export type ForkRecreateThreadWorktreeInput = typeof ForkRecreateThreadWorktreeInput.Type;
