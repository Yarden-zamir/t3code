import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  ProjectId,
  RunId,
  NodeId,
  RunAttemptId,
  ProviderThreadId,
  ProviderInstanceId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Config from "../config.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";
import * as Settings from "../serverSettings.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Resume from "./ForkWorktreeResume.ts";
import { makeSetupMarker } from "./forkWorktreeSetup.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
import { makeWorkspaceDependencies } from "./forkWorkspaceDependencies.ts";

const layerGit = Git.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "fork-worktree-resume-" })),
  Layer.provideMerge(NodeServices.layer),
);

interface PrepareOptions {
  readonly restore?: boolean;
  readonly eviction?: boolean;
  readonly exitCode?: number;
  readonly tracker?: Layer.Layer<Tracker.WorktreeSetupTracker>;
  readonly completion?: Effect.Effect<Setup.ProjectSetupScriptCompletion>;
}

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const dependencies = yield* makeWorkspaceDependencies;
  const root = yield* fs.makeTempDirectoryScoped();
  const repository = path.join(root, "repo");
  const cwd = path.join(root, "checkout");
  yield* fs.makeDirectory(repository);
  const exec = (args: readonly string[], location = repository) =>
    git.execute({ cwd: location, args, operation: "test worktree resume" });
  yield* exec(["init", "-b", "main"]);
  yield* exec(["config", "user.name", "Test"]);
  yield* exec(["config", "user.email", "test@example.com"]);
  yield* fs.writeFileString(path.join(repository, "package.json"), "{}");
  yield* exec(["add", "package.json"]);
  yield* exec(["commit", "-m", "initial"]);
  yield* exec(["branch", "saved"]);
  const input = {
    thread: {
      id: ThreadId.make("resume-thread"),
      projectId: ProjectId.make("resume-project"),
      worktreePath: cwd,
      branch: "saved",
    } as OrchestrationV2AppThread,
    run: {
      id: RunId.make("resume-run"),
      rootNodeId: NodeId.make("resume-node"),
      providerInstanceId: ProviderInstanceId.make("resume-provider"),
    } as OrchestrationV2Run,
    attemptId: RunAttemptId.make("resume-attempt"),
    providerThreadId: ProviderThreadId.make("resume-provider-thread"),
    turnItems: [],
  };
  const activities: OrchestrationV2DomainEvent[] = [];
  let setups = 0;
  const layer = ({
    restore = true,
    eviction = false,
    exitCode = 0,
    tracker = Tracker.layer,
    completion,
  }: PrepareOptions) =>
    Resume.layer.pipe(
      Layer.provide(tracker),
      Layer.provide(
        Layer.mergeAll(
          Settings.layerTest({
            restoreWorktreesOnResume: restore,
            worktreeArtifactEviction: eviction,
          }),
          IdAllocator.layer,
          Layer.mock(Projects.ProjectService)({
            getById: () =>
              Effect.succeedSome({
                id: input.thread.projectId,
                workspaceRoot: repository,
                scripts: [],
              } as never),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeIfRunCurrent: (request) =>
              Effect.sync(() => {
                activities.push(...request.events);
                return { committed: true, storedEvents: [] } as never;
              }),
            write: (request) =>
              Effect.sync(() => {
                activities.push(...request.events);
                return [];
              }),
          }),
          Layer.mock(Setup.ProjectSetupScriptRunner)({
            runForThread: (request) =>
              Effect.gen(function* () {
                setups++;
                assert.strictEqual(request.worktreePath, cwd);
                assert.isTrue(yield* fs.exists(path.join(cwd, "package.json")).pipe(Effect.orDie));
                return {
                  status: "started" as const,
                  scriptId: "setup",
                  scriptName: "Setup",
                  scriptCommand: "install",
                  terminalId: "setup",
                  cwd,
                  async: false,
                  completion:
                    completion ??
                    Effect.gen(function* () {
                      if (exitCode === 0)
                        for (const relative of yield* dependencies(cwd).pipe(Effect.orDie))
                          yield* fs
                            .makeDirectory(path.join(cwd, relative), { recursive: true })
                            .pipe(Effect.orDie);
                      return { exitCode, durationMs: 1 };
                    }),
                };
              }),
          }),
        ),
      ),
    );
  const prepare = (options: PrepareOptions = {}) =>
    Effect.gen(function* () {
      yield* (yield* Resume.ForkWorktreeResume).prepare(input);
    }).pipe(Effect.provide(layer(options)));
  const activityStatuses = () =>
    activities.flatMap((event) =>
      event.type === "turn-item.updated" ? [event.payload.status] : [],
    );
  return {
    fs,
    path,
    exec,
    cwd,
    repository,
    input,
    activities,
    activityStatuses,
    prepare,
    setups: () => setups,
  };
});

it.effect("restores the same branch and path, waits for setup, and publishes activity", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const before = yield* f.exec(["rev-parse", "saved"]);
    yield* f.exec(["worktree", "add", f.cwd, "saved"]);
    yield* f.fs.remove(f.cwd, { recursive: true });
    yield* f.prepare();
    assert.strictEqual((yield* f.exec(["rev-parse", "HEAD"], f.cwd)).stdout, before.stdout);
    assert.strictEqual(
      (yield* f.exec(["symbolic-ref", "--short", "HEAD"], f.cwd)).stdout.trim(),
      "saved",
    );
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules")));
    assert.strictEqual(f.setups(), 1);
    assert.lengthOf(f.activities, 2);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("runs setup for evicted dependencies without changing dirty files or HEAD", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.exec(["worktree", "add", f.cwd, "saved"]);
    yield* f.fs.writeFileString(f.path.join(f.cwd, "package.json"), '{"dirty":true}');
    yield* (yield* (yield* makeSetupMarker)(f.cwd)).mark;
    yield* f.prepare();
    yield* f.prepare();
    assert.strictEqual(
      yield* f.fs.readFileString(f.path.join(f.cwd, "package.json")),
      '{"dirty":true}',
    );
    assert.strictEqual(f.setups(), 1);
  }).pipe(Effect.provide(layerGit)),
);

it.effect(
  "repairs only the missing checkout and preserves every registration, ref and staged file",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const unrelated = f.path.join(f.path.dirname(f.cwd), "unrelated");
      yield* f.exec(["worktree", "add", "-b", "other", unrelated]);
      yield* f.exec(["worktree", "add", f.cwd, "saved"]);
      const unrelatedGit = (yield* f.exec(
        ["rev-parse", "--absolute-git-dir"],
        unrelated,
      )).stdout.trim();
      const targetGit = (yield* f.exec(["rev-parse", "--absolute-git-dir"], f.cwd)).stdout.trim();
      const unrelatedHead = yield* f.fs.readFileString(f.path.join(unrelatedGit, "HEAD"));
      const unrelatedGitdir = yield* f.fs.readFileString(f.path.join(unrelatedGit, "gitdir"));
      const unrelatedIndex = yield* f.fs.readFile(f.path.join(unrelatedGit, "index"));
      yield* f.fs.writeFileString(
        f.path.join(f.cwd, "package.json"),
        '{"description":"staged code state"}',
      );
      yield* f.exec(["add", "package.json"], f.cwd);
      yield* f.exec(["update-ref", "refs/worktree/restore-proof", "HEAD"], f.cwd);
      const stagedIndex = yield* f.fs.readFile(f.path.join(targetGit, "index"));
      const refs = (yield* f.exec(["show-ref"])).stdout;
      yield* f.fs.remove(unrelated, { recursive: true });
      yield* f.fs.remove(f.cwd, { recursive: true });
      yield* f.prepare();
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.cwd, "package.json")),
        '{"description":"staged code state"}',
      );
      assert.deepStrictEqual(yield* f.fs.readFile(f.path.join(targetGit, "index")), stagedIndex);
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(unrelatedGit, "HEAD")),
        unrelatedHead,
      );
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(unrelatedGit, "gitdir")),
        unrelatedGitdir,
      );
      assert.deepStrictEqual(
        yield* f.fs.readFile(f.path.join(unrelatedGit, "index")),
        unrelatedIndex,
      );
      assert.strictEqual((yield* f.exec(["show-ref"])).stdout, refs);
      assert.strictEqual(
        (yield* f.exec(["rev-parse", "refs/worktree/restore-proof"], f.cwd)).stdout,
        (yield* f.exec(["rev-parse", "saved"])).stdout,
      );
      assert.include(
        (yield* f.exec(["worktree", "list", "--porcelain"])).stdout,
        "branch refs/heads/other",
      );
      assert.isFalse(yield* f.fs.exists(unrelated));
    }).pipe(Effect.provide(layerGit)),
);

it.effect("does nothing while off", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.prepare({ restore: false });
    assert.isFalse(yield* f.fs.exists(f.cwd));
    assert.strictEqual(f.setups(), 0);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("leaves a missing checkout to upstream recovery while off, even with eviction on", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.prepare({ restore: false, eviction: true });
    assert.isFalse(yield* f.fs.exists(f.cwd));
    assert.strictEqual(f.setups(), 0);
    assert.deepStrictEqual(f.activities, []);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("a checkout without node_modules reruns setup only after eviction removed them", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.exec(["worktree", "add", f.cwd, "saved"]);
    yield* f.prepare({ eviction: true });
    yield* f.prepare({ eviction: true });
    assert.strictEqual(f.setups(), 0);
    yield* (yield* (yield* makeSetupMarker)(f.cwd)).mark;
    yield* f.prepare({ eviction: true });
    assert.strictEqual(f.setups(), 1);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("a stopped setup closes its activity as interrupted", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const started = yield* Deferred.make<void>();
    const startup = yield* f
      .prepare({
        completion: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    yield* Fiber.interrupt(startup);
    assert.deepStrictEqual(f.activityStatuses(), ["running", "interrupted"]);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("a crashed setup closes its activity as failed", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const exit = yield* f.prepare({ completion: Effect.die("setup crashed") }).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(exit));
    assert.deepStrictEqual(f.activityStatuses(), ["running", "failed"]);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("missing build output does not run setup or add a build step on resume", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.exec(["worktree", "add", f.cwd, "saved"]);
    yield* f.fs.makeDirectory(f.path.join(f.cwd, "node_modules"));
    yield* f.prepare();
    assert.strictEqual(f.setups(), 0);
    assert.isFalse(yield* f.fs.exists(f.path.join(f.cwd, "apps/mobile/android/app/build")));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("restores evicted dependencies even when the restore setting is off", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.exec(["worktree", "add", f.cwd, "saved"]);
    const marker = yield* (yield* makeSetupMarker)(f.cwd);
    yield* marker.mark;
    yield* f.prepare({ restore: false });
    assert.strictEqual(f.setups(), 1);
    assert.isFalse(yield* marker.pending);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules")));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("waits for the launcher's existing async setup instead of starting another", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.exec(["worktree", "add", f.cwd, "saved"]);
    const waiting = yield* Deferred.make<void>();
    const complete = yield* Deferred.make<void>();
    const trackerLayer = Layer.mock(Tracker.WorktreeSetupTracker)({
      get: () =>
        Effect.succeed({
          phase: "running",
          stages: [{ id: "setup-script", status: "running" }],
        } as never),
      stream: () =>
        Stream.fromEffect(
          Deferred.succeed(waiting, undefined).pipe(
            Effect.andThen(Deferred.await(complete)),
            Effect.as(null),
          ),
        ),
    });
    const startup = yield* f
      .prepare({ tracker: trackerLayer })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(waiting);
    assert.strictEqual(f.setups(), 0);
    yield* f.fs.makeDirectory(f.path.join(f.cwd, "node_modules"));
    yield* Deferred.succeed(complete, undefined);
    yield* Fiber.join(startup);
    assert.strictEqual(f.setups(), 0);
  }).pipe(Effect.provide(layerGit)),
);

it.effect.each([false, true])(
  "revives a deleted branch from fetched origin default (registered: %s)",
  (registered) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const remote = f.path.join(f.path.dirname(f.cwd), "origin");
      yield* f.exec(["clone", "--no-hardlinks", f.repository, remote]);
      yield* f.exec(["config", "user.name", "Test"], remote);
      yield* f.exec(["config", "user.email", "test@example.com"], remote);
      const defaultBranch = registered ? "trunk" : "main";
      if (registered) yield* f.exec(["branch", "-m", defaultBranch], remote);
      yield* f.fs.writeFileString(f.path.join(remote, "package.json"), '{"from":"origin"}');
      yield* f.exec(["add", "package.json"], remote);
      yield* f.exec(["commit", "-m", "remote-only change"], remote);
      yield* f.exec(["remote", "add", "origin", remote]);
      const mainBefore = (yield* f.exec(["rev-parse", "main"])).stdout;
      if (registered) {
        yield* f.exec(["worktree", "add", f.cwd, "saved"]);
        yield* f.fs.writeFileString(f.path.join(f.cwd, "package.json"), '{"old":"staged"}');
        yield* f.exec(["add", "package.json"], f.cwd);
        yield* f.fs.remove(f.cwd, { recursive: true });
      }
      yield* f.exec(["update-ref", "-d", "refs/heads/saved"]);
      yield* f.prepare();
      assert.strictEqual(
        (yield* f.exec(["rev-parse", "HEAD"], f.cwd)).stdout,
        (yield* f.exec(["rev-parse", `refs/heads/${defaultBranch}`], remote)).stdout,
      );
      assert.strictEqual(
        (yield* f.exec(["symbolic-ref", "--short", "HEAD"], f.cwd)).stdout.trim(),
        "saved",
      );
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.cwd, "package.json")),
        '{"from":"origin"}',
      );
      assert.strictEqual((yield* f.exec(["diff", "--cached"], f.cwd)).stdout, "");
      assert.strictEqual((yield* f.exec(["rev-parse", "main"])).stdout, mainBefore);
      assert.strictEqual(f.setups(), 1);
      assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules")));
      assert.include(
        JSON.stringify(f.activities),
        `The branch was gone, so this worktree was recreated from ${defaultBranch}. Earlier uncommitted work is not in it.`,
      );
    }).pipe(Effect.provide(layerGit)),
);

it.effect("a missing origin blocks deleted-branch recovery without creating a branch", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.exec(["branch", "-D", "saved"]);
    const error = yield* f.prepare().pipe(Effect.flip);
    assert.include(error.message, "could not be prepared");
    const branch = yield* f.exec(["show-ref", "--verify", "refs/heads/saved"]).pipe(Effect.flip);
    assert.isDefined(branch);
    assert.isFalse(yield* f.fs.exists(f.cwd));
    assert.strictEqual(f.setups(), 0);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("a deleted branch does not allow replacing an occupied saved path", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.exec(["branch", "-D", "saved"]);
    yield* f.fs.makeDirectory(f.cwd);
    yield* f.fs.writeFileString(f.path.join(f.cwd, "private"), "keep");
    const error = yield* f.prepare().pipe(Effect.flip);
    assert.include(error.message, "local branch does not exist");
    assert.strictEqual(yield* f.fs.readFileString(f.path.join(f.cwd, "private")), "keep");
    yield* f.exec(["show-ref", "--verify", "refs/heads/saved"]).pipe(Effect.flip);
    assert.strictEqual(f.setups(), 0);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("leaves a conflicting path and symbolic link untouched", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.makeDirectory(f.cwd);
    yield* f.fs.writeFileString(f.path.join(f.cwd, "private"), "keep");
    yield* f.prepare().pipe(Effect.flip);
    assert.strictEqual(yield* f.fs.readFileString(f.path.join(f.cwd, "private")), "keep");
    yield* f.fs.remove(f.cwd, { recursive: true });
    yield* f.fs.symlink(f.repository, f.cwd);
    const error = yield* f.prepare().pipe(Effect.flip);
    assert.include(error.message, "symbolic link");
    assert.strictEqual(f.setups(), 0);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("fails before starting the agent when setup fails, preserving the checkout", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const error = yield* f.prepare({ exitCode: 1 }).pipe(Effect.flip);
    assert.include(error.message, "setup exited with 1");
    assert.isTrue(yield* f.fs.exists(f.cwd));
    yield* f.prepare();
    assert.strictEqual(f.setups(), 2);
  }).pipe(Effect.provide(layerGit)),
);

// A server restart during setup is covered by upstream startup recovery, not by fork code.
// This pins that the fork's restore row is one of the rows it closes.
it.effect("server start closes a restore row that a restart left running", () =>
  Effect.gen(function* () {
    const ids = yield* IdAllocator.IdAllocatorV2;
    const threadId = ThreadId.make("restart-thread");
    const runId = RunId.make("restart-run");
    const restoreId = ids.derive.runSignalTurnItem({ runId, signal: "fork-worktree-restore" });
    const projection = {
      thread: { id: threadId, providerInstanceId: ProviderInstanceId.make("codex") },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [],
      runs: [{ id: runId, status: "interrupted", providerInstanceId: "codex" }],
      nodes: [],
      turnItems: [
        {
          id: restoreId,
          threadId,
          runId,
          nodeId: null,
          type: "command_execution",
          status: "running",
          title: "Restoring worktree dependencies",
          input: "Project setup",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const committed: OrchestrationV2DomainEvent[] = [];
    yield* Effect.gen(function* () {
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover;
    }).pipe(
      Effect.provide(
        ProviderRuntimeRecovery.layer.pipe(
          Layer.provide(Settings.layerTest()),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([threadId]),
                getRuntimeRecoveryProjection: () => Effect.succeed(projection),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                commitCommand: (input) =>
                  Effect.sync(() => {
                    committed.push(...input.events);
                    return { committed: true, cancelledEffectCount: 0 } as never;
                  }),
              }),
              IdAllocator.layer,
              Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                runRecoveryOnce: Effect.succeed(false),
              }),
              Layer.mock(EffectOutbox.EffectOutboxV2)({
                reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
                cancelUnsettled: () => Effect.succeed([]),
              }),
            ),
          ),
        ),
      ),
    );
    assert.deepStrictEqual(
      committed.flatMap((event) =>
        event.type === "turn-item.updated" ? [[event.payload.id, event.payload.status]] : [],
      ),
      [[restoreId, "cancelled"]],
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);
