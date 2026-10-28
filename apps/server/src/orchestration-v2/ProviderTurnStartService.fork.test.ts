import { expect, it, vi } from "vite-plus/test";
import {
  CheckpointScopeId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  ProjectId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ForkWorktreeResume from "../fork/ForkWorktreeResume.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const managedWorktreesDir = "/tmp/provider-turn-start-worktrees";
const realPaths = new Set([managedWorktreesDir, `${managedWorktreesDir}/project`]);

/** Starts a run on a thread whose worktree folder is missing, with routing reads failing after. */
function startWithMissingWorktree(
  worktreePath: string,
  prepareWorktree: ForkWorktreeResume.ForkWorktreeResume["Service"]["prepare"],
) {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch: "feature/restore",
      worktreePath,
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId, text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const writeIfRunCurrent = vi.fn(
    (_request: Parameters<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>[0]) =>
      Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const openSession = vi.fn(() => Effect.die("Provider must not open before setup succeeds"));
  const pruneWorktrees = vi.fn(() => Effect.void);
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const listLocalBranchNames = vi.fn(() => Effect.succeed(["feature/restore"]));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.succeed(ForkWorktreeResume.ForkWorktreeResume, { prepare: prepareWorktree }),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.succeed(FileSystem.FileSystem, {
          exists: () => Effect.succeed(false),
          realPath: (target: string) =>
            realPaths.has(target)
              ? Effect.succeed(target)
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "realPath",
                    pathOrDescriptor: target,
                  }),
                ),
        } as never),
        Path.layer,
        Layer.mock(ServerConfig.ServerConfig)({
          worktreesDir: managedWorktreesDir,
        } as ServerConfig.ServerConfig["Service"]),
        ServerSettings.layerTest(),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees,
          createWorktree,
          listLocalBranchNames,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getTurnStartContext: () =>
            Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
          getRuntimeRecoveryProjection: () =>
            Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: "simulated inherited-background projection failure",
              }),
            ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open: openSession }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  const start = Effect.gen(function* () {
    return yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);
  }).pipe(Effect.provide(layer), Effect.runPromise);
  const startAttempt = (willRetry: boolean) =>
    Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry,
      });
    }).pipe(Effect.provide(layer), Effect.runPromiseExit);
  return {
    start,
    startAttempt,
    writeIfRunCurrent,
    pruneWorktrees,
    createWorktree,
    startRootRun,
    openSession,
  };
}

it("does not open a provider or start a turn when setup fails, and preserves its error", async () => {
  const cwd = `${managedWorktreesDir}/project/feature-restore`;
  const failure = new ForkWorktreeResume.WorktreeResumeError({
    cwd,
    reason: "Project setup exited with code 7.",
  });
  const harness = startWithMissingWorktree(cwd, () => Effect.fail(failure));
  const error = await harness.start;
  expect(error.cause).toBe(failure);
  expect(failure.message).toContain("setup exited with code 7");
  expect(harness.openSession).not.toHaveBeenCalled();
  expect(harness.startRootRun).not.toHaveBeenCalled();
  expect(harness.pruneWorktrees).not.toHaveBeenCalled();
  expect(harness.createWorktree).not.toHaveBeenCalled();
});

it("fails the run with its reason when worktree preparation fails on the last attempt", async () => {
  const cwd = `${managedWorktreesDir}/project/feature-restore`;
  const failure = new ForkWorktreeResume.WorktreeResumeError({
    cwd,
    reason: "The saved path is not the expected worktree; it was left untouched.",
  });
  const harness = startWithMissingWorktree(cwd, () => Effect.fail(failure));
  expect((await harness.startAttempt(true))._tag).toBe("Failure");
  expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();

  await harness.startAttempt(false);
  const events = harness.writeIfRunCurrent.mock.calls.flatMap(([request]) => request.events);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "run.updated",
      payload: expect.objectContaining({ status: "failed" }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "turn-item.updated",
      payload: expect.objectContaining({
        type: "error",
        failure: expect.objectContaining({
          message: expect.stringContaining("not the expected worktree"),
        }),
      }),
    }),
  );
  expect(harness.openSession).not.toHaveBeenCalled();
});

it("runs fork worktree setup before startup takes the workspace lease", async () => {
  const cwd = `${managedWorktreesDir}/project/feature-restore`;
  // Setup opens a terminal, and a terminal takes this lease. Inside startup's lease it would wait forever.
  let setupGotLease = false;
  const harness = startWithMissingWorktree(cwd, () =>
    withWorkspaceLease(cwd, Effect.void).pipe(
      Effect.timeoutOption("1 second"),
      Effect.map((result) => {
        setupGotLease = result._tag === "Some";
      }),
    ),
  );
  await harness.start;
  expect(setupGotLease).toBe(true);
});
