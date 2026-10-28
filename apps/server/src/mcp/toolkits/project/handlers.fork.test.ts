import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type Project as ProjectRecord,
  type ModelSelection,
  type RuntimeMode,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("project settings written by t3_project_update are the ones the app resolves", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:actions");
    const project = {
      id: projectId,
      title: "Actions",
      workspaceRoot: "/projects/actions",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    } as unknown as ProjectRecord;
    // One instance, so every handler call below shares the same settings.
    const settingsService = yield* ServerSettings.ServerSettingsService.pipe(
      // Folded: the aggregate's scripts no longer count, as on a migrated server.
      Effect.provide(ServerSettings.layerTest({ projectSettingsFolded: true })),
    );
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const aggregateUpdates: Array<Parameters<Project.ProjectService["Service"]["update"]>[0]> = [];
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "client:session-1",
        thread: undefined,
        client: { sessionId: "session-1", label: "Claude Code", access: "full-access" },
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (launch) => {
          launched.push(launch);
          return Effect.succeed({
            threadId: launch.threadId,
            projection: {
              thread: {
                id: launch.threadId,
                projectId: launch.projectId,
                title: launch.title,
                modelSelection: launch.modelSelection,
              },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({
        update: (input) =>
          Effect.sync(() => {
            aggregateUpdates.push(input);
            return project;
          }),
        getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.succeed(ServerSettings.ServerSettingsService, settingsService),
      DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-actions-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const run = <Name extends "t3_project_update" | "t3_project_read" | "t3_thread_launch">(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
    ) =>
      toolkit
        .handle(name, params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    const scripts = [
      { id: "test", name: "Test", command: "pnpm test", icon: "test", runOnWorktreeCreate: false },
    ] as const;

    const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    const written = {
      scripts,
      defaultModelSelection: model,
      defaultThreadEnvMode: "worktree",
      autoPull: true,
    } as const;

    const updated = yield* run("t3_project_update", { projectId, ...written });
    expect(updated.at(-1)?.result).toMatchObject({ id: projectId, ...written });
    for (const key of Object.keys(written)) expect(aggregateUpdates.at(-1)).not.toHaveProperty(key);

    const settings = yield* settingsService.getSettings;
    expect(resolveProjectScripts(settings, project)).toEqual(scripts);
    expect(resolveProjectSettings(settings, projectId, project).settings).toMatchObject({
      defaultModelSelection: model,
      defaultThreadEnvMode: "worktree",
      defaultAutoPull: true,
    });

    const read = yield* run("t3_project_read", { projectId });
    expect(read.at(-1)?.result).toMatchObject(written);

    // A launch without a model takes the project's default through the resolver.
    const launch = yield* run("t3_thread_launch", { title: "Fix", projectId });
    expect(launch.at(-1)?.result).toMatchObject({ modelSelection: model });
    expect(launched[0]?.modelSelection).toEqual(model);

    // null removes the override; the project inherits the environment again.
    yield* run("t3_project_update", {
      projectId,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
    });
    const cleared = (yield* settingsService.getSettings).projectSettingsOverrides[projectId];
    expect(cleared).toEqual({ defaultProjectScripts: scripts, defaultAutoPull: true });
    const reread = yield* run("t3_project_read", { projectId });
    expect(reread.at(-1)?.result).toMatchObject({
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
    });
  }),
);

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: RuntimeMode;
  readonly defaultRuntimeMode?: RuntimeMode;
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
  // The project's own default model, which a test can clear between launches.
  const projectDefaults: { model: ModelSelection | null } = {
    model: input.overrideModel === undefined ? modelSelection : null,
  };
  const layerDependencies = Layer.mergeAll(
    ServerSettings.layerTest({
      ...(input.defaultRuntimeMode === undefined
        ? {}
        : { defaultRuntimeMode: input.defaultRuntimeMode }),
      ...(input.overrideModel === undefined
        ? {}
        : {
            projectSettingsFolded: true,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: input.overrideModel },
            },
          }),
    }),
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      // A thread exists once a launch started it.
      getThreadShell: (threadId) => {
        const launch = input.launched.find((candidate) => candidate.threadId === threadId);
        return Effect.succeed(
          launch === undefined
            ? null
            : ({
                id: launch.threadId,
                projectId: launch.projectId,
                modelSelection: launch.modelSelection,
                deletedAt: null,
              } as unknown as OrchestrationV2ThreadShell),
        );
      },
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: input.checkWorktreeBase ?? (() => Effect.void),
      launch: (launch) => {
        input.launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              title: launch.title,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: projectDefaults.model,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(PeerForwarding.PeerForwarding)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { projectId, modelSelection, projectDefaults, dependencies: layerDependencies };
};

it.effect("a launch retried with the same clientRequestId replays the first one", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = (clientRequestId: string | undefined) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          message: "Fix the bug",
          ...(clientRequestId === undefined ? {} : { clientRequestId }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch("fix-1");
    yield* launch("fix-1");
    yield* launch("fix-2");
    yield* launch(undefined);
    yield* launch(undefined);
    const ids = launched.map((input) => [input.commandId, input.threadId]);
    // The same key sends the same command and thread ids, which the launch
    // service replays instead of starting a second thread.
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[0]?.[0]).toMatch(/^mcp:launch:[0-9a-f]{64}$/);
    expect(ids[2]).not.toEqual(ids[0]);
    // Without a key every launch is new.
    expect(ids[3]).not.toEqual(ids[4]);
  }),
);

it.effect("a retried launch replays after the project loses its default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, projectDefaults, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = toolkit
      .handle("t3_thread_launch", { title: "Fix", projectId, clientRequestId: "fix-1" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch;
    projectDefaults.model = null;
    const retried = (yield* launch).at(-1)?.result;
    expect(retried).toMatchObject({ projectId, modelSelection });
    expect(launched.map((input) => input.threadId)).toEqual([
      launched[0]?.threadId,
      launched[0]?.threadId,
    ]);
  }),
);

it.effect("a retried worktree launch replays after its base ref is gone", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const base = { exists: true };
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        base.exists || workspaceStrategy.type !== "worktree"
          ? Effect.void
          : Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            ),
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = toolkit
      .handle("t3_thread_launch", {
        title: "Fix",
        projectId,
        clientRequestId: "fix-worktree",
        workspaceStrategy: { type: "worktree", baseRef: "feature", startFromOrigin: false },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch;
    base.exists = false;
    expect((yield* launch).at(-1)?.result).toMatchObject({ projectId });
    expect(launched.map((input) => input.threadId)).toEqual([
      launched[0]?.threadId,
      launched[0]?.threadId,
    ]);
  }),
);
