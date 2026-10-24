import { describe, expect, it } from "vite-plus/test";

import { resolveDraftTerminalWorkspace } from "./forkDraftTerminalWorkspace";

const local = {
  envMode: "local",
  worktreePath: null,
  branch: "main",
  startFromOrigin: false,
} as const;

describe("resolveDraftTerminalWorkspace", () => {
  it("runs a local draft in the project root on its branch", () => {
    expect(resolveDraftTerminalWorkspace({ ...local }, true)).toEqual({
      kind: "folder",
      worktreePath: null,
      branch: "main",
    });
  });

  it("runs a draft that points at an existing worktree in that worktree", () => {
    // The branch picker and Previous worktree both store an existing worktree with envMode
    // "worktree".
    const draft = {
      ...local,
      envMode: "worktree",
      worktreePath: "/worktrees/repo/feature",
      branch: "feature",
    } as const;
    expect(resolveDraftTerminalWorkspace(draft, true)).toEqual({
      kind: "folder",
      worktreePath: "/worktrees/repo/feature",
      branch: "feature",
    });
  });

  it("asks for a new worktree from the base branch of a New worktree draft", () => {
    const draft = { ...local, envMode: "worktree", startFromOrigin: true } as const;
    expect(resolveDraftTerminalWorkspace(draft, true)).toEqual({
      kind: "new-worktree",
      baseBranch: "main",
      startFromOrigin: true,
    });
  });

  it("runs a New worktree draft of a project without Git in the project root", () => {
    const draft = { ...local, envMode: "worktree", branch: null } as const;
    expect(resolveDraftTerminalWorkspace(draft, false)).toEqual({
      kind: "folder",
      worktreePath: null,
      branch: null,
    });
  });
});
