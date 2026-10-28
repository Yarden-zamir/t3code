import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ForkWorktreeRecreate from "../fork/ForkWorktreeRecreate.ts";
import { handoffFor } from "../fork/forkWorktreeHandoffTool.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";

const gone = "/worktrees/project/gone";
const lead = ThreadId.make("thread-lead");
const child = ThreadId.make("thread-child");
const projectId = ProjectId.make("project-fork");
const failedRun = RunId.make("run-failed");
const instance = ProviderInstanceId.make("codex");

const leadScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-fork"),
  capabilities: new Set(["worktree"]),
  issuedAt: 1,
  requestNamespace: "lead",
  thread: { threadId: lead, providerSessionId: "lead-session", providerInstanceId: instance },
  client: undefined,
};

const records = {
  runs: [
    { id: RunId.make("run-old"), status: "failed", ordinal: 1, userMessageId: "message-old" },
    { id: failedRun, status: "failed", ordinal: 2, userMessageId: "message-lost" },
    // Queued behind the failure and held, so it never ran.
    { id: RunId.make("run-held"), status: "queued", ordinal: 3, queueHeld: true },
  ],
  messages: [
    { id: "message-old", text: "Old.", attachments: [], createdBy: "user", creationSource: "web" },
    {
      id: "message-lost",
      text: "Finish the migration.",
      attachments: [{ type: "image", id: "image-1" }],
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: lead,
    },
  ],
};

const makeHarness = (options: {
  readonly restore: boolean;
  readonly worktreePath: string | null;
  readonly branchExists?: boolean;
  readonly sendFails?: boolean;
}) => {
  const thread = {
    id: child,
    projectId,
    providerInstanceId: instance,
    branch: "feature/child",
    worktreePath: options.worktreePath,
    archivedAt: null,
    deletedAt: null,
  };
  const dispatch = vi.fn((_: unknown) => Effect.succeed({ sequence: 1, storedEvents: [] }));
  const sendToThread = vi.fn((_: unknown) =>
    options.sendFails === true
      ? Effect.fail(
          new ThreadManagementService.ThreadManagementThreadArchivedError({ threadId: child }),
        )
      : Effect.succeed({
          delivery: "started",
        } as ThreadManagementService.ThreadManagementSendResult),
  );
  const createWorktree = vi.fn((input: { readonly newRefName?: string | undefined }) =>
    Effect.succeed({
      worktree: { path: `/worktrees/project/${input.newRefName}`, refName: input.newRefName ?? "" },
    }),
  );
  const services = Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch,
      sendToThread,
      getThreadShell: () => Effect.succeed(thread as never),
      getThreadRecords: () =>
        Effect.succeed({ thread, ...records } as unknown as OrchestrationV2ThreadProjection),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () =>
        Effect.succeedSome({ id: projectId, workspaceRoot: "/repo/project", scripts: [] } as never),
    }),
    ServerSettings.layerTest({
      restoreWorktreesOnResume: options.restore,
      newWorktreesStartFromOrigin: false,
    }),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      createWorktree,
      localStatus: () =>
        Effect.succeed({ isRepo: true, refName: "main", hasPrimaryRemote: true } as never),
      listLocalBranchNames: () =>
        Effect.succeed([
          "main",
          "feature/child-restored",
          ...(options.branchExists === true ? ["feature/child"] : []),
        ]),
      removeWorktree: () => Effect.void,
      deleteLocalBranch: () => Effect.void,
    }),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: () => Effect.succeed({ status: "no-script" } as const),
    }),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshStatus: () => Effect.die("refreshStatus is not part of this test"),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: () => Effect.succeed("trunk"),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({ environmentId: leadScope.environmentId } as never),
    }),
    NodeServices.layer,
  );
  const worktrees = WorktreeMcpService.layer.pipe(Layer.provide(services));
  const layer = Layer.mergeAll(
    worktrees,
    ForkWorktreeRecreate.layer.pipe(Layer.provide(worktrees), Layer.provide(services)),
    services,
  );
  const recreate = (runId: RunId) =>
    Effect.flatMap(ForkWorktreeRecreate.ForkWorktreeRecreate, (service) =>
      service.recreate({ threadId: child, runId, creationSource: "mobile" }),
    ).pipe(Effect.provide(layer));
  return { layer, dispatch, sendToThread, createWorktree, recreate };
};

const failureCode = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? (exit.cause.reasons[0] as { error?: { code?: string } })?.error?.code : "";

describe("a thread whose worktree folder is gone", () => {
  it.effect("moves to a new worktree only while Restore worktrees on resume is on", () =>
    Effect.gen(function* () {
      const on = makeHarness({ restore: true, worktreePath: gone });
      yield* handoffFor(leadScope, { threadId: child, branch: "feature/moved" }).pipe(
        Effect.provide(on.layer),
      );
      expect(on.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: child, expectedWorktreePath: gone }),
      );

      const off = makeHarness({ restore: false, worktreePath: gone });
      const exit = yield* handoffFor(leadScope, { threadId: child, branch: "feature/moved" }).pipe(
        Effect.provide(off.layer),
        Effect.exit,
      );
      expect(failureCode(exit)).toBe("already_in_worktree");
      expect(off.createWorktree).not.toHaveBeenCalled();
    }),
  );

  it.effect("never moves another thread that has no saved worktree or whose folder exists", () =>
    Effect.gen(function* () {
      for (const [worktreePath, code] of [
        [null, "invalid_request"],
        [process.cwd(), "already_in_worktree"],
      ] as const) {
        const harness = makeHarness({ restore: true, worktreePath });
        const exit = yield* handoffFor(leadScope, { threadId: child, branch: "feature/x" }).pipe(
          Effect.provide(harness.layer),
          Effect.exit,
        );
        expect(failureCode(exit)).toBe(code);
        expect(harness.dispatch).not.toHaveBeenCalled();
      }
    }),
  );

  it.effect(
    "recreates on a free branch and resends the latest failed run as the clicking user",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({ restore: true, worktreePath: gone });
        const result = yield* harness.recreate(failedRun);
        expect(result.branch).toBe("feature/child-restored-2");
        // A client message starts ahead of the held queue; the parent still gets the result.
        expect(harness.sendToThread).toHaveBeenCalledWith(
          expect.objectContaining({
            threadId: child,
            mode: "queue",
            text: "Finish the migration.",
            attachments: [{ type: "image", id: "image-1" }],
            createdBy: "user",
            creationSource: "mobile",
          }),
        );
        const stale = yield* Effect.exit(harness.recreate(RunId.make("run-old")));
        expect(failureCode(stale)).toBe("invalid_request");
        expect(harness.sendToThread).toHaveBeenCalledTimes(1);
      }),
  );

  it.effect.each([
    { branchExists: true, base: "feature/child" },
    { branchExists: false, base: "trunk" },
  ])(
    "starts from the old branch when it exists (exists: $branchExists)",
    ({ branchExists, base }) =>
      Effect.gen(function* () {
        const harness = makeHarness({ restore: true, worktreePath: gone, branchExists });
        yield* harness.recreate(failedRun);
        expect(harness.createWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ refName: base }),
        );
      }),
  );

  it.effect("fails when the message cannot be sent again", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ restore: true, worktreePath: gone, sendFails: true });
      const exit = yield* Effect.exit(harness.recreate(failedRun));
      expect(failureCode(exit)).toBe("operation_failed");
    }),
  );
});
