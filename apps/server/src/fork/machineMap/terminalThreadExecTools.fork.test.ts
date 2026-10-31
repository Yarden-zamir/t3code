import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  type ScheduledTask,
  ScheduledTaskId,
  TERMINAL_THREAD_INSTANCE_ID,
  TERMINAL_THREAD_MODEL_SELECTION,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as RemoteDelegation from "../../peer/RemoteDelegation.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { machineRequestNamespace } from "./machineAccess.ts";
import * as KitshnGrants from "../kitshn/KitshnGrants.ts";
import { fixedKitshnGrants } from "../kitshn/KitshnGrants.testkit.ts";
import { PEER } from "./MachineMap.testkit.ts";

// MM-1923 through the real tools: another machine needs exec only to run or stop code in a
// terminal thread. The handlers behind the gate meet unimplemented mocks, so any outcome other
// than the gate's refusal means that the call passed the gate.

const terminalThreadId = ThreadId.make("thread:terminal");
const terminalTask: ScheduledTask = {
  id: ScheduledTaskId.make("task:terminal"),
  title: "Bound",
  prompt: "echo hi",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: ProjectId.make("project:mcp-test"),
  threadId: terminalThreadId,
  workspaceStrategy: { type: "root" },
  modelSelection: TERMINAL_THREAD_MODEL_SELECTION,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

const machineSession: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: machineRequestNamespace({ machineId: PEER, sessionId: "session" }),
  thread: undefined,
  client: { sessionId: "session", label: "VPS", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const standardGrants = (exec: boolean) =>
  Effect.provideService(KitshnGrants.KitshnGrants, fixedKitshnGrants(exec));

/** "refused" when the exec gate refused the call, else "passed". */
const call = (name: string, args: Record<string, unknown>, exec: boolean) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, machineSession),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    standardGrants(exec),
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isFailure(exit)) return "passed";
      const text = exit.value.content[0];
      const refused =
        exit.value.isError === true &&
        text?.type === "text" &&
        text.text.includes('"capability_denied"') &&
        text.text.includes("runs commands");
      return refused ? "refused" : "passed";
    }),
  );

const layerTools = Layer.mergeAll(
  McpHttpServer.layerThreadToolkit,
  McpHttpServer.layerOrchestratorToolkit,
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed({
          ...liveThreadShell(threadId),
          providerInstanceId: TERMINAL_THREAD_INSTANCE_ID,
          modelSelection: TERMINAL_THREAD_MODEL_SELECTION,
        }),
    }),
  ),
  Layer.provide(
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      list: () => Effect.succeed({ tasks: [terminalTask] }),
    }),
  ),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
  Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
  Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
  Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
  Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
  Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
);

const threadId = terminalThreadId;
const queuedRunId = "run:queued";

it.effect.each([
  ["t3_thread_update", { threadId, action: "rename", title: "Logs" }],
  ["t3_thread_organize", { threadId, action: "settle" }],
  ["t3_thread_organize", { threadId, action: "archive" }],
  ["t3_queue", { threadId, action: "cancel", queuedRunId }],
  ["t3_queue", { threadId, action: "reorder", queuedRunId, beforeRunId: null }],
] as const)("a metadata write %s %o passes with standard grants", ([name, args]) =>
  call(name, args, false).pipe(
    Effect.map((outcome) => expect(outcome).toBe("passed")),
    Effect.provide(layerTools),
  ),
);

it.effect.each([
  ["t3_thread_send", { threadId, message: "rm -rf build" }],
  ["t3_thread_interrupt", { threadId }],
  ["t3_queue", { threadId, action: "promote_to_steer", queuedRunId, targetRunId: "run:active" }],
  ["t3_queue", { threadId, action: "edit", queuedRunId, text: "rm -rf build" }],
  ["run_scheduled_task_now", { taskId: terminalTask.id }],
] as const)("%s %o needs exec", ([name, args]) =>
  Effect.gen(function* () {
    expect(yield* call(name, args, false)).toBe("refused");
    expect(yield* call(name, args, true)).toBe("passed");
  }).pipe(Effect.provide(layerTools)),
);
