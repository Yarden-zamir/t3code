import { ThreadId, type ServerSettings, type StorageCleanupReportEntry } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as Git from "../vcs/GitVcsDriver.ts";
import { withRepositoryLease, withWorkspaceLease } from "../workspace/workspaceLease.ts";

/**
 * Fork: the "clean" stage of the worktree lifecycle for branches. Storage cleanup removes a
 * worktree folder; this deletes its branch when the branch holds nothing that restore needs.
 * See docs/fork/features.md "Worktree lifecycle".
 */

export type BranchOutcome =
  | { readonly deleted: true; readonly reason: string }
  | { readonly deleted: false; readonly reason: string };

export interface RepositoryBranches {
  readonly repository: string;
  /** For example `refs/remotes/origin/main`. Null when origin has no default branch. */
  readonly defaultRef: string | null;
  readonly localBranches: ReadonlySet<string>;
  /** Branches that a Git worktree registration names, also one whose folder is gone. */
  readonly checkedOut: ReadonlySet<string>;
}

export const sameSettings = (left: ServerSettings, right: ServerSettings) =>
  left.restoreWorktreesOnResume === right.restoreWorktreesOnResume;

export const makeBranchRules = Effect.gen(function* () {
  const git = yield* Git.GitVcsDriver;
  const run = (repository: string, args: ReadonlyArray<string>, writesSharedConfig = false) =>
    git.execute({
      operation: "ForkWorktreeBranches",
      cwd: repository,
      args,
      env: { LC_ALL: "C" },
      allowNonZeroExit: true,
      ...(writesSharedConfig ? { writesSharedConfig } : {}),
    });

  const inspect = Effect.fn("ForkWorktreeBranches.inspect")(function* (repository: string) {
    // Restore recreates a deleted branch from origin's default branch, so only origin counts.
    const defaultBranch = yield* git.resolveDefaultBranchName(repository, "origin");
    const [heads, worktrees] = yield* Effect.all([
      run(repository, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
      run(repository, ["worktree", "list", "--porcelain"]),
    ]);
    if (heads.exitCode !== 0 || worktrees.exitCode !== 0) return null;
    return {
      repository,
      defaultRef: defaultBranch === null ? null : `refs/remotes/origin/${defaultBranch}`,
      localBranches: new Set(heads.stdout.split("\n").filter(Boolean)),
      checkedOut: new Set(
        worktrees.stdout
          .split("\n")
          .filter((line) => line.startsWith("branch refs/heads/"))
          .map((line) => line.slice("branch refs/heads/".length)),
      ),
    } satisfies RepositoryBranches;
  });

  const tip = (repository: string, branch: string) =>
    run(repository, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
    );

  // A resumable thread's tip must be on origin's default branch: restore recreates it from there.
  // Other branches need each commit on a remote. Limit: a stale remote-tracking ref counts as on
  // the remote, because cleanup does not fetch; revisit if a pruned remote branch loses work.
  const deleteIfSpare = Effect.fn("ForkWorktreeBranches.deleteIfSpare")(function* (
    repository: RepositoryBranches,
    branch: string,
    resumable: boolean,
  ) {
    const keep = (reason: string): BranchOutcome => ({ deleted: false, reason });
    if (!repository.localBranches.has(branch)) return null;
    if (repository.defaultRef === null) return keep("origin has no default branch");
    if (repository.defaultRef === `refs/remotes/origin/${branch}`)
      return keep("it is the default branch");
    if (repository.checkedOut.has(branch)) return keep("a worktree uses it");
    const sha = yield* tip(repository.repository, branch);
    if (sha === null) return null;
    const ancestor = yield* run(repository.repository, [
      "merge-base",
      "--is-ancestor",
      sha,
      repository.defaultRef,
    ]);
    if (ancestor.exitCode > 1) return keep("its commits could not be compared");
    let reason = "no commits beyond the default branch";
    if (ancestor.exitCode === 1) {
      if (resumable)
        return keep(
          "a thread can still resume on it, and it has commits beyond the default branch",
        );
      const unpushed = yield* run(repository.repository, [
        "rev-list",
        "--max-count=1",
        sha,
        "--not",
        "--remotes",
      ]);
      if (unpushed.exitCode !== 0 || unpushed.stdout.trim() !== "")
        return keep("it has commits that are on no remote");
      reason = "its thread was deleted and its commits are on a remote";
    }
    // `branch -D` refuses a branch that a worktree checked out since the inspection.
    if ((yield* tip(repository.repository, branch)) !== sha) return keep("it moved since check");
    const deleted = yield* run(repository.repository, ["branch", "-D", branch], true);
    if (deleted.exitCode !== 0)
      return keep(deleted.stderr.trim().split("\n")[0] || "git branch -D failed");
    return { deleted: true, reason } satisfies BranchOutcome;
  });

  return { inspect, deleteIfSpare };
});

export const makeSweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const rules = yield* makeBranchRules;

  return Effect.fn("ForkWorktreeBranches.sweep")(function* (
    settings: ServerSettings,
    entries: StorageCleanupReportEntry[],
  ) {
    if (!settings.restoreWorktreesOnResume) return;
    const rows = yield* sql<{
      readonly threadId: string;
      readonly title: string;
      readonly deleted: number;
      readonly branch: string;
      readonly worktreePath: string;
      readonly workspaceRoot: string;
    }>`
      SELECT t.thread_id AS "threadId", t.title, t.deleted_at IS NOT NULL AS "deleted",
        json_extract(t.payload_json, '$.branch') AS "branch",
        json_extract(t.payload_json, '$.worktreePath') AS "worktreePath",
        p.workspace_root AS "workspaceRoot"
      FROM orchestration_v2_projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id
      WHERE json_extract(t.payload_json, '$.worktreePath') IS NOT NULL
        AND json_extract(t.payload_json, '$.branch') IS NOT NULL
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.catch((error) =>
        Effect.logWarning("storage cleanup could not read thread branches", { error }).pipe(
          Effect.as([]),
        ),
      ),
    );

    // Projects can share one repository, so group the threads by its common Git folder.
    const commonDirs = new Map<string, string | null>();
    const commonDir = Effect.fnUntraced(function* (workspaceRoot: string) {
      const root = path.resolve(workspaceRoot);
      if (!commonDirs.has(root))
        commonDirs.set(
          root,
          yield* git
            .execute({
              operation: "ForkWorktreeBranches.commonDir",
              cwd: root,
              args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            })
            .pipe(
              Effect.flatMap((result) => fs.realPath(result.stdout.trim())),
              Effect.orElseSucceed(() => null),
            ),
        );
      return commonDirs.get(root)!;
    });
    const groups = new Map<string, Array<(typeof rows)[number]>>();
    for (const row of rows) {
      const repository = yield* commonDir(row.workspaceRoot);
      if (repository === null) continue;
      const key = `${repository}\0${row.branch}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    for (const [key, group] of groups) {
      // A folder that still exists may use the branch; storage cleanup decides its folder first.
      const folders = [...new Set(group.map((row) => path.resolve(row.worktreePath)))].sort();
      const present = yield* Effect.forEach(folders, (folder) =>
        fs.exists(folder).pipe(Effect.orElseSucceed(() => true)),
      );
      if (present.some(Boolean)) continue;
      const repositoryKey = key.slice(0, key.indexOf("\0"));
      const first = group.find((row) => !row.deleted) ?? group[0]!;
      const resumable = group.some((row) => !row.deleted);
      const entry: StorageCleanupReportEntry = {
        kind: "worktree",
        outcome: "removed",
        reason: "",
        path: path.resolve(first.worktreePath),
        projectPath: first.workspaceRoot,
        threadId: ThreadId.make(first.threadId),
        threadTitle: first.title,
        bytes: null,
        files: null,
      };
      // Resume repairs a folder under the same lease, so it never sees a half-deleted branch.
      // Worktree creations wait for the repository lease, so the inspection stays current.
      const leased = folders.reduce(
        (effect, folder) => withWorkspaceLease(folder, effect),
        withRepositoryLease(
          repositoryKey,
          "exclusive",
          Effect.gen(function* () {
            const repository = yield* rules.inspect(first.workspaceRoot);
            if (repository === null) return null;
            return yield* rules.deleteIfSpare(repository, first.branch, resumable);
          }),
        ),
      );
      yield* leased.pipe(
        Effect.flatMap((outcome) =>
          Effect.gen(function* () {
            if (outcome === null || !outcome.deleted) return;
            const reason = `Deleted branch ${first.branch}: ${outcome.reason}`;
            const removal = entries.findIndex(
              (existing) =>
                existing.kind === "worktree" &&
                existing.outcome === "removed" &&
                existing.path === entry.path,
            );
            if (removal >= 0)
              entries[removal] = {
                ...entries[removal]!,
                reason: `${entries[removal]!.reason}. ${reason}`,
              };
            else entries.push({ ...entry, reason });
            yield* Effect.logInfo("storage cleanup deleted branch", {
              branch: first.branch,
              repository: repositoryKey,
              threadId: first.threadId,
              reason: outcome.reason,
            });
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            entries.push({
              ...entry,
              outcome: "failed",
              reason: `Branch ${first.branch}: ${error.message.split("\n")[0]}`,
            });
            yield* Effect.logWarning("storage cleanup could not check branch", {
              branch: first.branch,
              threadId: first.threadId,
              error,
            });
          }),
        ),
      );
    }
  });
});
