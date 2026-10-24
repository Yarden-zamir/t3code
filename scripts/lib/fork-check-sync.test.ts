// @effect-diagnostics nodeBuiltinImport:off - isolated Git fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { hasUnmergedSync } from "./fork-check-sync.ts";

it("detects an unmerged sync from its parents, not its branch name or message", () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-check-sync-"));
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      input: "",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    }).trim();
  try {
    git("init", "--quiet");
    const tree = git("mktree");
    const commit = (message: string, ...parents: Array<string>) =>
      git("commit-tree", tree, "-m", message, ...parents.flatMap((parent) => ["-p", parent]));
    const root = commit("root");
    const feature = commit("feature", root);
    const main = commit("merged feature", root, feature);
    git("update-ref", "refs/remotes/origin/main", main);
    git("update-ref", "HEAD", main);
    assert.isFalse(hasUnmergedSync(repo));

    const local = commit("local edit", main);
    git("update-ref", "HEAD", local);
    assert.isFalse(hasUnmergedSync(repo));

    const alreadyInMain = commit("merge an old feature", local, feature);
    git("update-ref", "HEAD", alreadyInMain);
    assert.isFalse(hasUnmergedSync(repo));

    const upstream = commit("upstream change", root);
    const sync = commit("arbitrary merge message", local, upstream);
    git("update-ref", "HEAD", sync);
    assert.isTrue(hasUnmergedSync(repo));
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      [NodePath.resolve(import.meta.dirname, "../fork-check.ts")],
      { cwd: repo, encoding: "utf8" },
    );
    assert.strictEqual(
      output,
      "Fork CI checks sync branches. Locally, run `vp run typecheck` and the fork tests in docs/fork/operations.md (Fork Sync).\n",
    );

    const repair = commit("repair after merge", sync);
    git("update-ref", "HEAD", repair);
    assert.isTrue(hasUnmergedSync(repo));

    git("update-ref", "refs/remotes/origin/main", sync);
    assert.isFalse(hasUnmergedSync(repo));
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
});
