import { resolveEffectiveEnvMode } from "./components/BranchToolbar.logic";
import { resolveSendEnvMode } from "./components/ChatView.logic";
import type { DraftThreadState } from "./composerDraftStore";

/**
 * Fork: where the shell of a draft in Terminal mode runs (`ForkDraftTerminalComposer`). A shell
 * needs a folder that exists, so a new worktree is a separate step before the shell starts.
 */
export type DraftTerminalWorkspace =
  | {
      readonly kind: "folder";
      /** Null runs the shell in the project root. */
      readonly worktreePath: string | null;
      readonly branch: string | null;
    }
  | {
      readonly kind: "new-worktree";
      /** Null until the branch picker of the context strip names a base. */
      readonly baseBranch: string | null;
      readonly startFromOrigin: boolean;
    };

/** The workspace choices of the context strip, with the meaning that a chat draft gives them. */
export function resolveDraftTerminalWorkspace(
  draft: Pick<DraftThreadState, "envMode" | "worktreePath" | "branch" | "startFromOrigin">,
  isGitRepo: boolean,
): DraftTerminalWorkspace {
  const envMode = resolveSendEnvMode({
    requestedEnvMode: resolveEffectiveEnvMode({
      activeWorktreePath: draft.worktreePath,
      hasServerThread: false,
      draftThreadEnvMode: draft.envMode,
    }),
    isGitRepo,
  });
  if (envMode === "worktree") {
    return {
      kind: "new-worktree",
      baseBranch: draft.branch,
      startFromOrigin: draft.startFromOrigin,
    };
  }
  return { kind: "folder", worktreePath: draft.worktreePath, branch: draft.branch };
}
