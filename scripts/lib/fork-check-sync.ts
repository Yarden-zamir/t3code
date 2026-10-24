// @effect-diagnostics nodeBuiltinImport:off - plain Node script.
import * as NodeChildProcess from "node:child_process";

export function hasUnmergedSync(repoRoot: string): boolean {
  const commits = NodeChildProcess.execFileSync(
    "git",
    ["rev-list", "--parents", "origin/main..HEAD"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
  // The range excludes every commit already in main, including merged feature branches.
  const outsideMain = new Set(commits.map(([commit]) => commit));
  return commits.some(
    ([, , secondParent]) => secondParent !== undefined && outsideMain.has(secondParent),
  );
}
