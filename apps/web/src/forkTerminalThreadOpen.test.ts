import { TERMINAL_THREAD_ENV } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { terminalThreadOpenInput } from "./forkTerminalThreadOpen";

describe("terminalThreadOpenInput", () => {
  it("starts a new shell with the shell, the worktree and the environment of the thread", () => {
    const input = terminalThreadOpenInput({
      threadId: "thread-1",
      workspaceRoot: "/repo/main",
      worktreePath: "/repo/feature",
      shell: "bash",
    });
    expect(input).toMatchObject({
      shell: "bash",
      cwd: "/repo/feature",
      worktreePath: "/repo/feature",
      env: expect.objectContaining({ [TERMINAL_THREAD_ENV]: "1" }),
    });
  });

  it("names no shell for the default shell, so the server fills in the shell of the thread", () => {
    const input = terminalThreadOpenInput({
      threadId: "thread-1",
      workspaceRoot: "/repo/main",
      worktreePath: null,
      shell: undefined,
    });
    expect(input).not.toHaveProperty("shell");
    expect(input.cwd).toBe("/repo/main");
  });
});
