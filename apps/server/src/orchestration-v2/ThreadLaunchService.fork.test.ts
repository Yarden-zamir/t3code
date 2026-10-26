import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:launch-test");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

interface HarnessOptions {
  readonly managedFolders?: Layer.Layer<ManagedProjectFolders.ManagedProjectFolders>;
  readonly hasCommit?: GitWorkflow.GitWorkflowService["Service"]["hasCommit"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
}

function makeHarness(options: HarnessOptions = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest(options.serverSettings);
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const createWorktree = vi.fn<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>(
    (input) =>
      Effect.succeed({
        worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
      } as never),
  );
  const runSetup = vi.fn<
    ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
  >(options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })));
  const removeWorktree = vi.fn<GitWorkflow.GitWorkflowService["Service"]["removeWorktree"]>(
    () => Effect.void,
  );
  const closeTerminal = vi.fn<TerminalManager.TerminalManager["Service"]["close"]>(
    () => Effect.void,
  );
  const generateBranchName = vi.fn<TextGeneration.TextGeneration["Service"]["generateBranchName"]>(
    () => Effect.succeed({ branch: "generated-branch" }),
  );
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: closeTerminal }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      getByWorkspaceRoot: () => Effect.succeedSome(project),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      createWorktree,
      renameBranch: (input) => Effect.succeed({ branch: input.newBranch }),
      fetchWorktreeBaseCommit: () =>
        Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
      hasCommit: options.hasCommit ?? (() => Effect.succeed(false)),
      isOutsideRepository: () => Effect.succeed(false),
      resolveWorktreeBaseRemote: () => Effect.succeed({ remoteName: "origin", branchName: "main" }),
      remoteExists: () => Effect.succeed(true),
      remoteBranchExists: () => Effect.succeed(true),
      removeWorktree,
      ...options.git,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle: () => Effect.succeed({ title: "Generated title" }),
      generateBranchName,
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(),
    options.managedFolders ??
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
        folderForThread: () => Effect.succeedNone,
      }),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerThreadManagement,
        layerReceipts,
        IdAllocator.layer,
      ),
    ),
  );
  return {
    // The same layer as the launch service gets, so a test reads the tracker that it writes.
    layer: Layer.mergeAll(
      layerLaunch,
      layerThreadManagement,
      layerDatabase,
      WorktreeSetupTracker.layer,
    ),
    createWorktree,
    generateBranchName,
    runSetup,
    removeWorktree,
    closeTerminal,
  };
}

function launchInput(input: {
  readonly command: string;
  readonly thread: string;
  readonly message?: string;
  readonly workspace?: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
}) {
  return {
    commandId: CommandId.make(input.command),
    threadId: ThreadId.make(input.thread),
    projectId,
    title: "New thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceStrategy: input.workspace ?? { type: "root" as const },
    ...(input.message === undefined
      ? {}
      : {
          initialMessage: {
            messageId: MessageId.make(`${input.message}:id`),
            text: input.message,
            attachments: [],
          },
        }),
    createdBy: "user" as const,
    creationSource: "web" as const,
  };
}

/** Settles once preparation releases the run, or fails it. */
const preparationSettled = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.streamStoredEventsFrom({ threadId }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          (stored.commandId?.endsWith(":release") === true ||
            stored.event.payload.status === "failed"),
      ),
      Stream.runHead,
    );
    return yield* threads.getThreadProjection(threadId);
  });

it.effect.each([
  { name: "Scratch in a folder of its own", scratchFolder: Option.some("/scratch/folder") },
  { name: "another project in the project folder", scratchFolder: Option.none<string>() },
])("runs a worktree request outside a repository: $name", (testCase) =>
  Effect.gen(function* () {
    // Only `projectId` stands in for the Scratch project here.
    const harness = makeHarness({
      git: { isOutsideRepository: () => Effect.succeed(true) },
      managedFolders: Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(Option.isSome(testCase.scratchFolder)),
        folderForThread: () => Effect.succeed(testCase.scratchFolder),
      }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:non-repository-worktree",
          thread: "thread:launch:non-repository-worktree",
          message: "Summarize my day",
          workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
        }),
      );
      const settled = yield* preparationSettled(launched.threadId);
      // The project folder case runs in the main checkout, where upstream skips the setup action.
      if (Option.isSome(testCase.scratchFolder)) {
        assert.equal(
          harness.runSetup.mock.calls[0]?.[0]?.worktreePath,
          testCase.scratchFolder.value,
        );
      }
      assert.equal(harness.createWorktree.mock.calls.length, 0);
      assert.equal(settled.thread.worktreePath, Option.getOrNull(testCase.scratchFolder));
      // Only the project folder case differs from the request in a way to report.
      const notices = (yield* threads.getThreadRecords(launched.threadId, [
        "turnItems",
      ])).turnItems.filter((item) => item.type === "system_notice");
      assert.equal(notices.length, Option.isSome(testCase.scratchFolder) ? 0 : 1);
      assert.equal(
        harness.runSetup.mock.calls.length,
        Option.isSome(testCase.scratchFolder) ? 1 : 0,
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([
  { name: "refuses", scratch: false },
  // The launch gives it a Scratch thread folder.
  { name: "leaves Scratch to the launch for", scratch: true },
])("$name a new worktree in a folder outside any repository", (testCase) =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: () => Effect.succeed(true),
      git: { isOutsideRepository: () => Effect.succeed(true) },
      managedFolders: Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(testCase.scratch),
      }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const check = launches.checkWorktreeBase({
        projectId,
        workspaceStrategy: { type: "worktree", baseRef: "main" },
      });
      if (testCase.scratch) return yield* check;
      assert.deepInclude(yield* check.pipe(Effect.flip), {
        _tag: "ThreadLaunchNotRepositoryError",
        projectId,
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("names the branch from the message before creating a templated worktree", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      serverSettings: { worktreePathTemplate: "{repoDir}/{branchLeaf}" },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const launched = yield* launches.launch(
        launchInput({
          command: "command:launch:template-branch",
          thread: "thread:launch:template-branch",
          message: "Fix the sidebar flicker",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* preparationSettled(launched.threadId);
      const [input, options] = harness.createWorktree.mock.calls[0] ?? [];
      assert.equal(input?.newRefName, "t3/fix-the-sidebar-flicker");
      assert.equal(options?.pickFreeName, true);
      assert.equal(harness.generateBranchName.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([
  { name: "already exists", branches: ["main", "docs/taken"] },
  { name: "a branch blocks", branches: ["main", "docs"] },
])("refuses a new worktree whose branch $name", (testCase) =>
  Effect.gen(function* () {
    const harness = makeHarness({
      git: { listLocalBranchNames: () => Effect.succeed(testCase.branches) },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const error = yield* launches
        .checkWorktreeBase({
          projectId,
          workspaceStrategy: { type: "worktree", baseRef: "main", branch: "docs/taken" },
        })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "ThreadLaunchBranchExistsError",
        projectId,
        branch: "docs/taken",
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("leaves a temporary branch that a branch blocks to the launch, which flattens it", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: () => Effect.succeed(true),
      git: { listLocalBranchNames: () => Effect.succeed(["main", "t3"]) },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.checkWorktreeBase({
        projectId,
        workspaceStrategy: { type: "worktree", baseRef: "main", branch: "t3/0123abcd" },
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("an agent's launch never starts work above the modes it asks for", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    // The first launch, at full access, creates the thread without a message.
    const created = yield* launches.launch(
      launchInput({ command: "command:launch:narrowed-retry", thread: "thread:narrowed" }),
    );
    // The same key comes back from a narrower agent, now carrying a message,
    // as a retry or a concurrent launch that lost the create would.
    const failed = yield* launches
      .launch({
        ...launchInput({
          command: "command:launch:narrowed-retry",
          thread: "thread:narrowed",
          message: "Run this",
        }),
        runtimeMode: "approval-required",
        interactionMode: "plan",
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.flip);
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "dispatch-message");
    const projection = yield* threads.getThreadProjection(created.threadId);
    assert.equal(projection.runs.length, 0);
    assert.equal(projection.messages.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

// The new worktree of a draft in Terminal mode, which has no thread yet.
const draftSetupStarted = (
  async: boolean,
  completion: Effect.Effect<{ exitCode: number | null; durationMs: number }>,
) =>
  Effect.succeed({
    status: "started" as const,
    async,
    scriptId: "setup",
    scriptName: "Setup",
    scriptCommand: "vp install",
    terminalId: "setup-setup",
    cwd: "/repo-worktrees/feature",
    completion,
  });

it.effect("prepares a draft worktree from origin and starts its setup script", () =>
  Effect.gen(function* () {
    const fetchBase = vi.fn<GitWorkflow.GitWorkflowService["Service"]["fetchWorktreeBaseCommit"]>(
      () => Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
    );
    const harness = makeHarness({
      git: { fetchWorktreeBaseCommit: fetchBase },
      runSetup: () => draftSetupStarted(true, Effect.never),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const threadId = ThreadId.make("thread:draft-worktree");
      const prepared = yield* launches.prepareDraftWorktree({
        projectId,
        threadId,
        baseRef: "main",
        startFromOrigin: true,
      });
      assert.equal(prepared.worktreePath, "/repo-worktrees/feature");
      assert.match(prepared.branch ?? "", /^t3\//u);
      assert.equal(fetchBase.mock.calls.length, 1);
      assert.equal(harness.createWorktree.mock.calls[0]?.[0].refName, "remote-main-sha");
      assert.deepEqual(
        harness.runSetup.mock.calls.map(([input]) => [input.threadId, input.worktreePath]),
        [[threadId, "/repo-worktrees/feature"]],
      );
      assert.deepEqual(
        (yield* tracker.get(threadId))?.stages.map((stage) => [stage.id, stage.status]),
        [
          ["fetch", "done"],
          ["checkout", "done"],
          ["setup-script", "running"],
        ],
      );
      assert.isEmpty(harness.removeWorktree.mock.calls);
      assert.isNull(yield* threads.getThreadShell(threadId));
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("removes a draft worktree whose setup script fails", () => {
  const harness = makeHarness({
    runSetup: () => draftSetupStarted(false, Effect.succeed({ exitCode: 1, durationMs: 1 })),
    git: { hasRefNamed: () => Effect.succeed(true) },
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
    const threadId = ThreadId.make("thread:draft-worktree-setup-fails");
    const failure = yield* launches
      .prepareDraftWorktree({ projectId, threadId, baseRef: "main", startFromOrigin: false })
      .pipe(Effect.flip);
    assert.match(ThreadLaunch.failureDetail(failure), /Setup script exited with 1/u);
    assert.deepEqual(
      harness.removeWorktree.mock.calls.map(([input]) => input.path),
      ["/repo-worktrees/feature"],
    );
    assert.deepEqual(
      harness.closeTerminal.mock.calls.map(([input]) => [input.threadId, input.terminalId]),
      [[threadId, "setup-setup"]],
    );
    assert.equal((yield* tracker.get(threadId))?.phase, "failed");
  }).pipe(Effect.provide(harness.layer));
});
