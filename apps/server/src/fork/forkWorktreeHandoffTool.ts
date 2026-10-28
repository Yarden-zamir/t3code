import {
  type ThreadId,
  WorktreeMcpFailure,
  type WorktreeMcpHandoffInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as WorktreeMcpService from "../mcp/WorktreeMcpService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/** The upstream handoff acts as the thread of its scope. It reads the session id only to name commands. */
export const actAsThread = (
  scope: McpInvocationContext.McpInvocationScope,
  thread: Pick<McpInvocationContext.McpThreadCaller, "threadId" | "providerInstanceId">,
): McpInvocationContext.McpInvocationScope => ({
  ...scope,
  thread: {
    ...thread,
    providerSessionId: scope.thread?.providerSessionId ?? "fork-worktree-recreate",
  },
});

/**
 * Fork: `t3_worktree_handoff` with `threadId`. Another thread needs a saved worktree. The upstream
 * handoff then refuses a folder that exists or a disabled "Restore worktrees on resume", so a busy
 * thread never loses its running turn.
 */
export const handoffFor = Effect.fn("ForkWorktreeHandoff.handoffFor")(function* (
  scope: McpInvocationContext.McpInvocationScope,
  input: WorktreeMcpHandoffInput,
) {
  const service = yield* WorktreeMcpService.WorktreeMcpService;
  const target: ThreadId | undefined = input.threadId;
  // Without a calling thread, the upstream handoff refuses as before.
  if (target === undefined || scope.thread === undefined || target === scope.thread.threadId)
    return yield* service.handoff(scope, input);
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const shell = yield* threads.getThreadShell(target).pipe(Effect.orElseSucceed(() => null));
  if (shell === null || shell.deletedAt !== null || shell.worktreePath === null)
    return yield* new WorktreeMcpFailure({
      code: "invalid_request",
      message: `Thread '${target}' has no saved worktree. Another thread moves only when its worktree folder is gone.`,
    });
  return yield* service.handoff(
    actAsThread(scope, { threadId: shell.id, providerInstanceId: shell.providerInstanceId }),
    input,
  );
});

/** The write checks of the other thread tools apply to `threadId`. */
export const forkWorktreeHandoff = McpToolAccess.writesThreads(
  (input: WorktreeMcpHandoffInput) => [input.threadId],
  (input: WorktreeMcpHandoffInput) =>
    McpInvocationContext.McpInvocationContext.pipe(
      Effect.flatMap((scope) => handoffFor(scope, input)),
    ),
);
