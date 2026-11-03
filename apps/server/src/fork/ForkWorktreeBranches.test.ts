import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type StorageCleanupReportEntry } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as Config from "../config.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { withRepositoryLease } from "../workspace/workspaceLease.ts";
import * as Branches from "./ForkWorktreeBranches.ts";

const layerGit = Git.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "fork-worktree-branches-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

// origin has main and `pushed`. The clone has `spare` (on main), `local-work` (one commit on no
// remote), `pushed` (its commit is only on origin/pushed) and `in-use` (checked out in a worktree).
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped();
  const origin = path.join(root, "origin.git");
  const repository = path.join(root, "repo");
  const exec = (args: readonly string[], cwd = repository) =>
    git.execute({ cwd, args, operation: "test worktree branches" });
  yield* fs.makeDirectory(origin);
  yield* exec(["init", "--bare", "-b", "main"], origin);
  yield* exec(["clone", origin, repository], root);
  yield* exec(["config", "user.name", "Test"]);
  yield* exec(["config", "user.email", "test@example.com"]);
  const commit = (message: string) => exec(["commit", "--allow-empty", "-m", message]);
  yield* commit("initial");
  yield* exec(["push", "origin", "main"]);
  yield* exec(["remote", "set-head", "origin", "main"]);
  yield* exec(["branch", "spare"]);
  yield* exec(["branch", "in-use"]);
  yield* exec(["worktree", "add", path.join(root, "in-use"), "in-use"]);
  for (const branch of ["local-work", "pushed"]) {
    yield* exec(["switch", "-c", branch, "main"]);
    yield* commit(branch);
  }
  yield* exec(["push", "origin", "pushed"]);
  yield* exec(["switch", "main"]);
  const exists = (branch: string) =>
    git
      .execute({
        cwd: repository,
        args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        allowNonZeroExit: true,
        operation: "test worktree branches",
      })
      .pipe(Effect.map((result) => result.exitCode === 0));
  return { root, repository, exec, exists, fs, path };
});

it.effect("deletes a branch only when no commit is lost and restore can rebuild it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const rules = yield* Branches.makeBranchRules;
    const cases = [
      { branch: "main", resumable: false, deleted: false },
      { branch: "in-use", resumable: false, deleted: false },
      { branch: "local-work", resumable: false, deleted: false },
      { branch: "local-work", resumable: true, deleted: false },
      // Restore recreates a deleted branch from origin/main, which lacks this commit.
      { branch: "pushed", resumable: true, deleted: false },
      { branch: "pushed", resumable: false, deleted: true },
      { branch: "spare", resumable: true, deleted: true },
    ];
    for (const { branch, resumable, deleted } of cases) {
      const repository = yield* rules.inspect(f.repository);
      assert.isNotNull(repository);
      const outcome = yield* rules.deleteIfSpare(repository!, branch, resumable);
      assert.strictEqual(outcome?.deleted, deleted, `${branch} resumable=${resumable}`);
      assert.strictEqual(yield* f.exists(branch), !deleted, branch);
    }
    assert.isNull(
      yield* rules.deleteIfSpare((yield* rules.inspect(f.repository))!, "spare", false),
      "a branch that is gone needs nothing",
    );
  }).pipe(Effect.provide(layerGit)),
);

it.effect("keeps every branch without an origin default branch", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.exec(["remote", "set-head", "origin", "--delete"]);
    const rules = yield* Branches.makeBranchRules;
    const outcome = yield* rules.deleteIfSpare(
      (yield* rules.inspect(f.repository))!,
      "spare",
      true,
    );
    assert.isFalse(outcome?.deleted);
    assert.isTrue(yield* f.exists("spare"));
  }).pipe(Effect.provide(layerGit)),
);

it.effect.each(["succeeds", "fails"] as const)(
  "branch cleanup cannot run between the branch creation and checkout of a worktree when the common folder lookup %s",
  (lookup) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const scope = yield* Scope.Scope;
      // A failed lookup with no cached common folder falls back to the checkout key.
      const leaseKey = yield* f.fs.realPath(
        lookup === "succeeds" ? f.path.join(f.repository, ".git") : f.repository,
      );
      const live = yield* ChildProcessSpawner.ChildProcessSpawner;
      const order: string[] = [];
      const cleanups: Array<Fiber.Fiber<number>> = [];
      // At `worktree add`, the new branch exists but no worktree uses it yet. A cleanup that asks
      // for the lease first must still wait, while a second creation shares the lease.
      const git = yield* Git.make.pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (command._tag !== "StandardCommand") return yield* live.spawn(command);
              const args = command.args;
              if (lookup === "fails" && args.includes("--git-common-dir")) {
                return yield* live.spawn(
                  ChildProcess.make(
                    command.command,
                    ["rev-parse", "--verify", "--quiet", "refs/heads/no-such-branch"],
                    command.options,
                  ),
                );
              }
              if (args.includes("worktree") && args.includes("add")) {
                cleanups.push(
                  yield* withRepositoryLease(
                    leaseKey,
                    "exclusive",
                    Effect.sync(() => order.push("cleanup")),
                  ).pipe(Effect.forkIn(scope)),
                );
                const otherCreation = yield* Deferred.make<void>();
                yield* withRepositoryLease(
                  leaseKey,
                  "shared",
                  Deferred.succeed(otherCreation, undefined),
                ).pipe(Effect.forkIn(scope));
                yield* Deferred.await(otherCreation);
                order.push("checkout");
              }
              return yield* live.spawn(command);
            }),
          ),
        ),
      );
      yield* git.createWorktree({
        cwd: f.repository,
        refName: "main",
        newRefName: "fresh",
        path: f.path.join(f.root, "fresh"),
      });
      assert.strictEqual(cleanups.length, 1);
      yield* Fiber.join(cleanups[0]!);
      assert.deepStrictEqual(order, ["checkout", "cleanup"]);
    }).pipe(Effect.provide(layerGit)),
);

it.effect("the sweep reads resumable from the threads and skips folders that exist", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const row = (threadId: string, branch: string, deleted: boolean, folder = threadId) => ({
      threadId,
      title: threadId,
      deleted: deleted ? 1 : 0,
      branch,
      worktreePath: f.path.join(f.root, "gone", folder),
      workspaceRoot: f.repository,
    });
    yield* f.fs.makeDirectory(f.path.join(f.root, "gone", "present"), { recursive: true });
    yield* f.exec(["branch", "kept-by-folder"]);
    const rows = [
      // A live thread can resume on `pushed`, so the deleted one does not decide alone.
      row("deleted-pushed", "pushed", true),
      row("live-pushed", "pushed", false),
      row("deleted-spare", "spare", true),
      // The folder of this thread still exists.
      row("present", "kept-by-folder", true, "present"),
    ];
    const sql = (() => Effect.succeed(rows)) as unknown as SqlClient.SqlClient;
    const sweep = yield* Branches.makeSweep.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const entries: StorageCleanupReportEntry[] = [];
    yield* sweep({ ...DEFAULT_SERVER_SETTINGS, restoreWorktreesOnResume: false }, entries);
    assert.isTrue(yield* f.exists("spare"), "the restore setting gates branch cleanup");
    yield* sweep({ ...DEFAULT_SERVER_SETTINGS, restoreWorktreesOnResume: true }, entries);
    assert.isFalse(yield* f.exists("spare"));
    assert.isTrue(yield* f.exists("pushed"));
    assert.isTrue(yield* f.exists("kept-by-folder"));
    assert.deepStrictEqual(
      entries.map((entry) => `${entry.threadId}:${entry.outcome}`),
      ["deleted-spare:removed"],
    );
  }).pipe(Effect.provide(layerGit)),
);
