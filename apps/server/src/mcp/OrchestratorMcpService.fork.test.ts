import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  TERMINAL_THREAD_MODEL_SELECTION,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const parentThreadId = ThreadId.make("thread:mcp-terminal-parent");
const codexInstanceId = ProviderInstanceId.make("codex");
const terminalInstanceId = TERMINAL_THREAD_MODEL_SELECTION.instanceId;

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-terminal"),
  requestNamespace: "provider-session:mcp-terminal",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:mcp-terminal",
    providerInstanceId: codexInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const modelSelection = { instanceId: codexInstanceId, model: "gpt-5.4" };
const parentProjection = {
  thread: {
    id: parentThreadId,
    projectId: ProjectId.make("project:mcp-terminal"),
    title: "MCP parent",
    createdBy: "user",
    creationSource: "web",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
  },
  runs: [
    {
      id: RunId.make("run:mcp-terminal-parent"),
      ordinal: 1,
      status: "running",
      rootNodeId: NodeId.make("node:mcp-terminal-root"),
      providerInstanceId: codexInstanceId,
      modelSelection,
    },
  ],
  contextTransfers: [],
  subagents: [],
} as unknown as OrchestrationV2ThreadProjection;

const terminalProvider: ServerProvider = {
  instanceId: terminalInstanceId,
  driver: ProviderDriverKind.make("terminal"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [
    {
      slug: TERMINAL_THREAD_MODEL_SELECTION.model,
      name: TERMINAL_THREAD_MODEL_SELECTION.model,
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

const layerDependencies = Layer.mergeAll(
  NodeServices.layer,
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    hasReceipt: () => Effect.succeed(false),
    getThreadRecords: () => Effect.succeed(parentProjection),
    dispatch: () => Effect.die("A brief is never typed into a shell."),
  }),
  Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([terminalProvider]),
    refreshInstance: () => Effect.succeed([terminalProvider]),
  }),
  Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      list: () => Effect.succeed([terminalInstanceId]),
      get: (instanceId) =>
        Effect.succeed({ instanceId } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]),
    }),
  ),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  ServerSettings.layerTest(),
);

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(layerDependencies),
);

describe("OrchestratorMcpService terminal threads", () => {
  it.effect("refuses delegation to a terminal thread", () =>
    Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const error = yield* service
        .delegateTask(scope, {
          task: "Run `rm -rf build`.",
          target: { providerInstanceId: terminalInstanceId },
          mode: "async",
          clientRequestId: "delegate-terminal-1",
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "invalid_request");
      assert.include(error.message, "t3_thread_launch");
    }).pipe(Effect.provide(layerOrchestratorService)),
  );
});
