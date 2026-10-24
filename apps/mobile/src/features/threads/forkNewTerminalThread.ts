import type { TerminalThreadWorkspace } from "@t3tools/client-runtime/state/fork-terminal-thread-creation";
import type { VcsRef } from "@t3tools/client-runtime/state/vcs";

/** Fork: where the shell of a new terminal thread runs, as the New terminal thread sheet offers it. */
export type TerminalFolderChoice =
  | { readonly kind: "project" }
  | { readonly kind: "worktree"; readonly worktreePath: string; readonly branch: string | null }
  | { readonly kind: "new-worktree" };

export interface ExistingWorktree {
  readonly worktreePath: string;
  readonly branch: string;
}

/** The worktrees of a project, one per folder, from its local branches. The project root is not one. */
export function existingTerminalWorktrees(
  refs: ReadonlyArray<VcsRef>,
  workspaceRoot: string,
): ReadonlyArray<ExistingWorktree> {
  const byPath = new Map<string, ExistingWorktree>();
  for (const ref of refs) {
    if (ref.isRemote === true || ref.worktreePath === null) continue;
    if (ref.worktreePath === workspaceRoot || byPath.has(ref.worktreePath)) continue;
    byPath.set(ref.worktreePath, { worktreePath: ref.worktreePath, branch: ref.name });
  }
  return [...byPath.values()];
}

/** The choice that the workspace of the new-thread draft means, so the sheet opens on it. */
export function terminalFolderChoiceOfDraft(
  workspace: TerminalThreadWorkspace,
): TerminalFolderChoice {
  if (workspace.kind === "new-worktree") return { kind: "new-worktree" };
  return workspace.worktreePath === null
    ? { kind: "project" }
    : { kind: "worktree", worktreePath: workspace.worktreePath, branch: workspace.branch };
}

/** The base of a new worktree: the base branch of the draft, else the default branch, else the current one. */
export function newWorktreeBaseBranch(
  workspace: TerminalThreadWorkspace,
  refs: ReadonlyArray<VcsRef>,
): string | null {
  if (workspace.kind === "new-worktree" && workspace.baseBranch !== null) {
    return workspace.baseBranch;
  }
  return (
    refs.find((ref) => ref.isDefault)?.name ??
    refs.find((ref) => ref.current && ref.isRemote !== true)?.name ??
    null
  );
}

/**
 * The folder and branch of a thread in an existing folder. The project folder runs on the branch
 * that its checkout has now, which is null in a folder without Git.
 */
export function terminalThreadFolder(
  choice: Exclude<TerminalFolderChoice, { readonly kind: "new-worktree" }>,
  refs: ReadonlyArray<VcsRef>,
): { readonly worktreePath: string | null; readonly branch: string | null } {
  if (choice.kind === "worktree") {
    return { worktreePath: choice.worktreePath, branch: choice.branch };
  }
  return {
    worktreePath: null,
    branch: refs.find((ref) => ref.current && ref.isRemote !== true)?.name ?? null,
  };
}
