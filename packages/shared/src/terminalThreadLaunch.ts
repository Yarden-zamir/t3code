import { TERMINAL_THREAD_ENV } from "@t3tools/contracts";

import { projectScriptCwd, projectScriptRuntimeEnv } from "./projectScripts.ts";

/**
 * How the main terminal of a terminal thread opens. The web view, the mobile screen and the
 * `terminal` provider driver all use this, because `terminal.open` restarts a running terminal
 * when its cwd or env differ from the open call before.
 */
export function terminalThreadLaunch(input: {
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
}) {
  return {
    cwd: projectScriptCwd({
      project: { cwd: input.workspaceRoot },
      worktreePath: input.worktreePath,
    }),
    worktreePath: input.worktreePath,
    env: {
      ...projectScriptRuntimeEnv({
        project: { cwd: input.workspaceRoot },
        worktreePath: input.worktreePath,
      }),
      [TERMINAL_THREAD_ENV]: "1",
    },
  } as const;
}
