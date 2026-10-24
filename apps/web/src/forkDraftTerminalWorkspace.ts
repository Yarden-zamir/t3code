import {
  terminalThreadWorkspace,
  type TerminalThreadWorkspace,
} from "@t3tools/client-runtime/state/fork-terminal-thread-creation";

import { resolveEffectiveEnvMode } from "./components/BranchToolbar.logic";
import { resolveSendEnvMode } from "./components/ChatView.logic";
import type { DraftThreadState } from "./composerDraftStore";

/**
 * Fork: where the shell of a draft in Terminal mode runs (`ForkDraftTerminalComposer`), from the
 * workspace choices of the context strip, with the meaning that a chat draft gives them.
 */
export function resolveDraftTerminalWorkspace(
  draft: Pick<DraftThreadState, "envMode" | "worktreePath" | "branch" | "startFromOrigin">,
  isGitRepo: boolean,
): TerminalThreadWorkspace {
  const envMode = resolveSendEnvMode({
    requestedEnvMode: resolveEffectiveEnvMode({
      activeWorktreePath: draft.worktreePath,
      hasServerThread: false,
      draftThreadEnvMode: draft.envMode,
    }),
    isGitRepo,
  });
  return terminalThreadWorkspace({
    mode: envMode === "worktree" ? "worktree" : "local",
    worktreePath: draft.worktreePath,
    branch: draft.branch,
    startFromOrigin: draft.startFromOrigin,
  });
}
