import type { VcsRef } from "@t3tools/client-runtime/state/vcs";
import { describe, expect, it } from "vite-plus/test";

import {
  existingTerminalWorktrees,
  newWorktreeBaseBranch,
  terminalFolderChoiceOfDraft,
  terminalThreadFolder,
} from "./forkNewTerminalThread";

const root = "/repo";
const ref = (name: string, fields: Partial<VcsRef> = {}): VcsRef => ({
  name,
  current: false,
  isDefault: false,
  worktreePath: null,
  ...fields,
});
const refs = [
  ref("main", { isDefault: true, current: true, worktreePath: root }),
  ref("feature", { worktreePath: "/worktrees/feature" }),
  ref("origin/feature", { isRemote: true, worktreePath: "/worktrees/remote" }),
  ref("plain"),
];

describe("existingTerminalWorktrees", () => {
  it("lists local branches that have their own folder, not the project root", () => {
    expect(existingTerminalWorktrees(refs, root)).toEqual([
      { worktreePath: "/worktrees/feature", branch: "feature" },
    ]);
  });

  it("lists a folder once", () => {
    const twice = [...refs, ref("feature-alias", { worktreePath: "/worktrees/feature" })];
    expect(existingTerminalWorktrees(twice, root)).toHaveLength(1);
  });
});

describe("terminalFolderChoiceOfDraft", () => {
  it("opens on the folder that the new-thread draft chose", () => {
    expect(
      terminalFolderChoiceOfDraft({ kind: "folder", worktreePath: null, branch: "main" }),
    ).toEqual({ kind: "project" });
    expect(
      terminalFolderChoiceOfDraft({
        kind: "folder",
        worktreePath: "/worktrees/feature",
        branch: "feature",
      }),
    ).toEqual({ kind: "worktree", worktreePath: "/worktrees/feature", branch: "feature" });
    expect(
      terminalFolderChoiceOfDraft({
        kind: "new-worktree",
        baseBranch: "main",
        startFromOrigin: false,
      }),
    ).toEqual({ kind: "new-worktree" });
  });
});

describe("newWorktreeBaseBranch", () => {
  it("keeps the base branch of a New worktree draft", () => {
    expect(
      newWorktreeBaseBranch(
        { kind: "new-worktree", baseBranch: "plain", startFromOrigin: true },
        refs,
      ),
    ).toBe("plain");
  });

  it("falls back to the default branch, then the current branch", () => {
    const local = { kind: "folder", worktreePath: null, branch: "feature" } as const;
    expect(newWorktreeBaseBranch(local, refs)).toBe("main");
    const noDefault = refs.map((candidate) => ({ ...candidate, isDefault: false }));
    expect(newWorktreeBaseBranch(local, noDefault)).toBe("main");
    expect(newWorktreeBaseBranch(local, [])).toBeNull();
  });
});

describe("terminalThreadFolder", () => {
  it("runs the project folder on its current branch", () => {
    expect(terminalThreadFolder({ kind: "project" }, refs)).toEqual({
      worktreePath: null,
      branch: "main",
    });
    expect(terminalThreadFolder({ kind: "project" }, [])).toEqual({
      worktreePath: null,
      branch: null,
    });
  });

  it("runs an existing worktree on its branch", () => {
    expect(
      terminalThreadFolder(
        { kind: "worktree", worktreePath: "/worktrees/feature", branch: "feature" },
        refs,
      ),
    ).toEqual({ worktreePath: "/worktrees/feature", branch: "feature" });
  });
});
