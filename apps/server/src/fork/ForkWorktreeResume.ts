import type {
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  RunAttemptId,
  RunId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as Settings from "../serverSettings.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { makeSetupMarker } from "./forkWorktreeSetup.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";

export class WorktreeResumeError extends Schema.TaggedError<WorktreeResumeError>()(
  "WorktreeResumeError",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `This thread's workspace folder no longer exists or is not a directory: ${this.cwd}. ${this.reason}`;
  }
}

export class ForkWorktreeResume extends Context.Service<
  ForkWorktreeResume,
  {
    readonly prepare: (input: {
      readonly thread: OrchestrationV2AppThread;
      readonly run: OrchestrationV2Run;
      readonly attemptId: RunAttemptId;
      readonly providerThreadId: ProviderThreadId;
      readonly turnItems: ReadonlyArray<Pick<OrchestrationV2TurnItem, "runId" | "ordinal">>;
    }) => Effect.Effect<void, WorktreeResumeError>;
  }
>()("t3/fork/ForkWorktreeResume") {}

const isWorktreeResumeError = Schema.is(WorktreeResumeError);
const RESTORE_SIGNAL = "fork-worktree-restore";

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* Settings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const setup = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const git = yield* Git.GitVcsDriver;
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const markerFor = yield* makeSetupMarker;
  const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;

  const prepare: ForkWorktreeResume["Service"]["prepare"] = Effect.fn("ForkWorktreeResume.prepare")(
    function* (input: Parameters<ForkWorktreeResume["Service"]["prepare"]>[0]) {
      const { thread, run } = input;
      const cwd = thread.worktreePath;
      if (cwd === null) return;
      const marker = yield* markerFor(cwd);
      const pendingSetup = yield* marker.pending;
      const currentSettings = yield* settings.getSettings;
      if (
        !currentSettings.restoreWorktreesOnResume &&
        !currentSettings.worktreeArtifactEviction &&
        !pendingSetup
      )
        return;
      // With restoration off, upstream's recovery after this hook handles a missing checkout.
      if (!currentSettings.restoreWorktreesOnResume && !pendingSetup && !(yield* fs.exists(cwd)))
        return;
      const fail = (reason: string) => new WorktreeResumeError({ cwd, reason });
      // A new launch can release its first turn while its async setup is still running.
      // Wait for that setup rather than typing a second install into its terminal.
      const ongoing = yield* tracker.get(thread.id);
      if (
        ongoing?.phase === "running" &&
        ongoing.stages.some((stage) => stage.id === "setup-script" && stage.status === "running")
      ) {
        const finished = yield* tracker.stream(thread.id).pipe(
          Stream.filter((snapshot) => snapshot?.phase !== "running"),
          Stream.runHead,
        );
        if (
          Option.isSome(finished) &&
          finished.value !== null &&
          (finished.value.phase !== "done" ||
            finished.value.stages.some(
              (stage) => stage.id === "setup-script" && stage.status === "failed",
            ))
        )
          return yield* fail("Project setup did not succeed. Retry setup before continuing.");
      }
      // Repair under the same lease as storage cleanup, so a cleanup that already started
      // finishes first. Setup runs after this lease ends: its terminal takes the lease itself.
      let recreationNotice = "";
      const { project, repository, exists } = yield* withWorkspaceLease(
        path.resolve(cwd),
        Effect.gen(function* () {
          if (!path.isAbsolute(cwd) || thread.branch === null)
            return yield* fail("The saved worktree path or branch is missing.");
          const project = yield* projects.getById(thread.projectId);
          if (Option.isNone(project)) return yield* fail("The project repository is missing.");
          const repository = project.value.workspaceRoot;
          const exec = (args: readonly string[], location = repository) =>
            git.execute({ cwd: location, args, operation: "restore worktree" });
          const common = yield* exec([
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ]).pipe(
            Effect.mapError(
              (cause) =>
                new WorktreeResumeError({
                  cwd,
                  reason: "The project repository is missing or cannot be read.",
                  cause,
                }),
            ),
          );
          // readLink also sees dangling links. Never replace an occupied path or follow a worktree link.
          const link = yield* fs.readLink(cwd).pipe(Effect.option);
          if (Option.isSome(link))
            return yield* fail("The saved path is a symbolic link; it was left untouched.");
          const exists = yield* fs.exists(cwd);
          if (exists && (yield* fs.stat(cwd)).type !== "Directory")
            return yield* fail(
              "The saved path exists but is not a directory; it was left untouched.",
            );
          const branch = yield* git.execute({
            cwd: repository,
            args: ["show-ref", "--verify", "--quiet", `refs/heads/${thread.branch}`],
            allowNonZeroExit: true,
            operation: "check saved worktree branch",
          });
          if (branch.exitCode !== 0 && (exists || branch.exitCode !== 1))
            return yield* fail("The saved local branch does not exist or cannot be read.");
          const recreateBranch = Effect.fn("ForkWorktreeResume.recreateBranch")(function* () {
            if (branch.exitCode === 0) return;
            yield* exec(["check-ref-format", "--branch", thread.branch!]);
            const remote = yield* exec(["ls-remote", "--symref", "origin", "HEAD"]);
            const defaultBranch = remote.stdout.match(/^ref: refs\/heads\/([^\r\n]+)\tHEAD$/m)?.[1];
            if (!defaultBranch)
              return yield* fail(
                "The origin default branch could not be determined; no branch was created.",
              );
            yield* exec([
              "fetch",
              "origin",
              `refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
            ]);
            // No force: a branch created concurrently must be left untouched.
            yield* exec([
              "branch",
              "--no-track",
              thread.branch!,
              `refs/remotes/origin/${defaultBranch}`,
            ]);
            recreationNotice = `The branch was gone, so this worktree was recreated from ${defaultBranch}. Earlier uncommitted work is not in it.`;
          });
          if (exists) {
            const [actualCommon, actualBranch, top] = yield* Effect.all([
              exec(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd),
              exec(["symbolic-ref", "HEAD"], cwd),
              exec(["rev-parse", "--show-toplevel"], cwd),
            ]).pipe(
              Effect.mapError(
                (cause) =>
                  new WorktreeResumeError({
                    cwd,
                    reason: "The saved path is not the expected worktree; it was left untouched.",
                    cause,
                  }),
              ),
            );
            const [expectedCommon, worktreeCommon, worktreeRoot, savedRoot] = yield* Effect.all([
              fs.realPath(common.stdout.trim()),
              fs.realPath(actualCommon.stdout.trim()),
              fs.realPath(top.stdout.trim()),
              fs.realPath(cwd),
            ]);
            if (
              expectedCommon !== worktreeCommon ||
              actualBranch.stdout.trim() !== `refs/heads/${thread.branch}` ||
              worktreeRoot !== savedRoot
            ) {
              return yield* fail(
                "The saved path is not the expected worktree; it was left untouched.",
              );
            }
          } else {
            const canonicalMissing = (target: string) =>
              fs.realPath(path.dirname(target)).pipe(
                Effect.map((parent) => path.join(parent, path.basename(target))),
                Effect.orElseSucceed(() => path.resolve(target)),
              );
            const registrations = path.join(yield* fs.realPath(common.stdout.trim()), "worktrees");
            const names = yield* fs.readDirectory(registrations).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.succeed([]),
              ),
            );
            const matching: string[] = [];
            for (const name of names) {
              const registration = path.join(registrations, name);
              const gitdir = yield* fs.readFileString(path.join(registration, "gitdir"));
              if (
                (yield* canonicalMissing(path.dirname(gitdir.trim()))) ===
                (yield* canonicalMissing(cwd))
              )
                matching.push(registration);
            }
            if (matching.length > 1)
              return yield* fail("Multiple Git registrations name this path; none was changed.");
            const registration = matching[0];
            if (registration !== undefined) {
              if (
                (yield* fs.realPath(registration)) !== registration ||
                (yield* fs.exists(path.join(registration, "locked"))) ||
                (yield* fs.exists(path.join(registration, "index.lock")))
              )
                return yield* fail(
                  "The saved worktree registration is linked or locked; it was left untouched.",
                );
              if (
                (yield* fs.readFileString(path.join(registration, "HEAD"))).trim() !==
                  `ref: refs/heads/${thread.branch}` ||
                !(yield* fs.exists(path.join(registration, "index")))
              )
                return yield* fail(
                  "The saved worktree registration does not match its branch and index; it was left untouched.",
                );
              yield* recreateBranch();
              yield* fs.makeDirectory(path.dirname(cwd), { recursive: true });
              yield* fs.makeDirectory(cwd);
              yield* fs.writeFileString(path.join(cwd, ".git"), `gitdir: ${registration}\n`, {
                flag: "wx",
              });
              yield* exec(["worktree", "repair", cwd]);
              // A deleted branch is explicitly revived from origin, not from its stale saved index.
              if (recreationNotice) yield* exec(["read-tree", "HEAD"], cwd);
              // Existing branches retain their saved index, including staged changes.
              yield* exec(["checkout-index", "--all"], cwd);
            } else {
              yield* recreateBranch();
              // No reset, force or broad prune, including when reviving a deleted branch.
              yield* exec(["worktree", "add", "--no-guess-remote", "--", cwd, thread.branch]);
            }
          }
          return { project, repository, exists };
        }),
      );
      // Only a restored checkout or dependencies that eviction removed need setup. A project
      // whose setup never creates node_modules must not rerun setup on every turn.
      const needsSetup = pendingSetup || !exists;
      if (!needsSetup) return;
      yield* marker.mark;
      const startedAt = yield* DateTime.now;
      const activityEvent = Effect.fn("ForkWorktreeResume.activityEvent")(function* (
        status: "running" | "completed" | "failed" | "interrupted",
        output: string,
      ) {
        const now = yield* DateTime.now;
        const item: OrchestrationV2TurnItem = {
          id: ids.derive.runSignalTurnItem({ runId: run.id, signal: RESTORE_SIGNAL }),
          threadId: thread.id,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: input.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal:
            Math.max(
              0,
              ...input.turnItems
                .filter((item) => item.runId === run.id)
                .map((item) => item.ordinal),
            ) + 1,
          type: "command_execution",
          status,
          title: exists ? "Restoring worktree dependencies" : "Restored missing worktree",
          input: "Project setup",
          output: recreationNotice ? `${recreationNotice}\n${output}` : output,
          ...(status === "completed"
            ? { exitCode: 0 }
            : status === "failed"
              ? { exitCode: 1 }
              : {}),
          startedAt,
          completedAt: status === "running" ? null : now,
          updatedAt: now,
        };
        return {
          id: yield* ids.allocate.event({ threadId: thread.id }),
          threadId: thread.id,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          type: "turn-item.updated" as const,
          payload: item,
        };
      });
      const activity = Effect.fn("ForkWorktreeResume.activity")(function* (
        status: "running" | "completed",
        output: string,
      ) {
        yield* sink.writeIfRunCurrent({
          threadId: thread.id,
          runId: run.id,
          activeAttemptId: input.attemptId,
          expectedStatus: "starting",
          events: [yield* activityEvent(status, output)],
        });
      });
      // A stopped or crashed setup must still close its row, and the run may no longer be
      // starting by then, so this write is not tied to the run's state.
      const finishActivity = Effect.fn("ForkWorktreeResume.finishActivity")(function* <E>(
        exit: Exit.Exit<void, E>,
      ) {
        if (Exit.isSuccess(exit)) return;
        const interrupted = Cause.hasInterruptsOnly(exit.cause);
        const failure = Cause.findErrorOption(exit.cause);
        const output = interrupted
          ? "Project setup stopped before it finished. Retry setup before continuing."
          : Option.isSome(failure) && isWorktreeResumeError(failure.value)
            ? failure.value.reason
            : "Project setup failed. The checkout and branch were kept.";
        yield* activityEvent(interrupted ? "interrupted" : "failed", output).pipe(
          Effect.flatMap((event) => sink.write({ events: [event] })),
          Effect.catchCause((cause) =>
            Effect.logWarning("fork worktree restore could not close its activity", {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      });
      yield* Effect.gen(function* () {
        yield* activity("running", "Running project setup before the agent starts.");
        const result = yield* setup.runForThread({
          threadId: thread.id,
          projectId: thread.projectId,
          projectCwd: repository,
          worktreePath: cwd,
          observeCompletion: {},
          project: project.value,
        });
        if (result.status === "started" && result.completion) {
          const completed = yield* result.completion;
          if (completed.exitCode !== 0)
            return yield* fail(
              `Project setup exited with ${completed.exitCode ?? "no exit code"}. The checkout and branch were kept; retry setup before continuing.`,
            );
        }
        if (pendingSetup && result.status === "no-script")
          return yield* fail(
            "Artifacts were removed, but no project setup script is configured. Configure setup before continuing.",
          );
        yield* marker.clear;
        yield* activity(
          "completed",
          result.status === "no-script"
            ? "No project setup script is configured."
            : "Project setup finished.",
        );
      }).pipe(Effect.onExit(finishActivity));
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isWorktreeResumeError(cause)
            ? cause
            : new WorktreeResumeError({
                cwd: input.thread.worktreePath ?? "",
                reason:
                  "The worktree could not be prepared. Existing branches were not reset and existing checkout files were not replaced.",
                cause,
              }),
        ),
      ),
  );
  return ForkWorktreeResume.of({ prepare });
});

export const layer = Layer.effect(ForkWorktreeResume, make);

// The core orchestration layer also runs without fork extensions (replay and upstream tests).
// Production installs this service at the same boundary as the project setup runner.
export const makePrepare = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(ForkWorktreeResume);
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return Effect.fn("ForkWorktreeResume.prepareTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) {
    if (Option.isNone(service)) return;
    // Turn startup reads the same context next and reports its own errors.
    const projection = yield* projections
      .getTurnStartContext(input.threadId, input.runId)
      .pipe(Effect.option);
    if (Option.isNone(projection)) return;
    const { thread, runs, attempts, providerThreads, turnItems } = projection.value;
    const run = runs.find((candidate) => candidate.id === input.runId);
    if (run === undefined || run.status !== "starting") return;
    const attempt = attempts.find((candidate) => candidate.id === run.activeAttemptId);
    const providerThread = providerThreads.find(
      (candidate) => candidate.id === run.providerThreadId,
    );
    if (attempt === undefined || providerThread === undefined) return;
    yield* service.value.prepare({
      thread,
      run,
      attemptId: attempt.id,
      providerThreadId: providerThread.id,
      turnItems,
    });
  });
});
