import {
  ProjectId,
  TERMINAL_THREAD_INSTANCE_ID,
  TERMINAL_THREAD_MODEL_SELECTION,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveTerminalShell,
  terminalThreadCreateInput,
  terminalThreadWorkspace,
} from "./forkTerminalThreadCreation.ts";

const base = {
  threadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  branch: "main",
  worktreePath: null,
  createdAt: "2026-10-24T10:00:00.000Z",
};

describe("terminalThreadCreateInput", () => {
  it("names a thread without a command after its shell, with the shell as model", () => {
    const input = terminalThreadCreateInput({ ...base, shell: "zsh" });
    expect(input.title).toBe("zsh");
    expect(input.modelSelection).toEqual({ instanceId: TERMINAL_THREAD_INSTANCE_ID, model: "zsh" });
  });

  it("uses the legacy model for the default shell", () => {
    const input = terminalThreadCreateInput({ ...base, shell: undefined });
    expect(input.modelSelection).toEqual(TERMINAL_THREAD_MODEL_SELECTION);
    expect(input.title).toBe("Terminal");
  });

  it("names a thread after the program of the command that made it", () => {
    const input = terminalThreadCreateInput({
      ...base,
      shell: "zsh",
      command: "GITHUB_TOKEN=ghp_x git push origin --force",
    });
    expect(input.title).toBe("git push origin");
  });
});

describe("resolveTerminalShell", () => {
  const shells = [{ slug: "zsh" }, { slug: "bash" }];

  it("keeps a shell that the server offers, else takes its default", () => {
    expect(resolveTerminalShell(shells, "bash")).toBe("bash");
    expect(resolveTerminalShell(shells, "removed-custom")).toBe("zsh");
    expect(resolveTerminalShell(shells, null)).toBe("zsh");
    expect(resolveTerminalShell([], "zsh")).toBeUndefined();
  });
});

describe("terminalThreadWorkspace", () => {
  it("needs a new worktree only in worktree mode", () => {
    expect(
      terminalThreadWorkspace({
        mode: "worktree",
        worktreePath: "/stale",
        branch: "main",
        startFromOrigin: true,
      }),
    ).toEqual({ kind: "new-worktree", baseBranch: "main", startFromOrigin: true });
    expect(
      terminalThreadWorkspace({
        mode: "local",
        worktreePath: "/worktrees/feature",
        branch: "feature",
        startFromOrigin: true,
      }),
    ).toEqual({ kind: "folder", worktreePath: "/worktrees/feature", branch: "feature" });
  });
});
