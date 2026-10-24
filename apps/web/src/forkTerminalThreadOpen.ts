import { DEFAULT_TERMINAL_ID, type TerminalOpenInput } from "@t3tools/contracts";
import { terminalThreadLaunch } from "@t3tools/shared/terminalThreadLaunch";

/**
 * Fork: the `terminal.open` input of the main terminal of a terminal thread or a terminal draft.
 * The first start and each "Start a new shell" send this input, so the new shell runs the same
 * shell, in the same folder, with the same environment. A different shell, folder or environment
 * would make the server restart a running terminal.
 */
export function terminalThreadOpenInput(input: {
  readonly threadId: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  /** Undefined means the default shell of the server. */
  readonly shell: string | undefined;
}): TerminalOpenInput {
  const launch = terminalThreadLaunch({
    workspaceRoot: input.workspaceRoot,
    worktreePath: input.worktreePath,
  });
  return {
    threadId: input.threadId,
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: launch.cwd,
    worktreePath: launch.worktreePath,
    env: { ...launch.env },
    ...(input.shell ? { shell: input.shell } : {}),
  };
}
