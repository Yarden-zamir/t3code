import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MachineId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  TERMINAL_THREAD_INSTANCE_ID,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import { machineRequestNamespace } from "../fork/machineMap/machineAccess.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const supervisedThreadId = ThreadId.make("thread:supervised");
const planThreadId = ThreadId.make("thread:plan");
const fullAccessThreadId = ThreadId.make("thread:full-access");
const endedThreadId = ThreadId.make("thread:ended");
const terminalThreadId = ThreadId.make("thread:terminal");

const shells = new Map([
  [supervisedThreadId, liveThreadShell(supervisedThreadId, { runtimeMode: "approval-required" })],
  [
    planThreadId,
    liveThreadShell(planThreadId, { runtimeMode: "approval-required", interactionMode: "plan" }),
  ],
  [fullAccessThreadId, liveThreadShell(fullAccessThreadId)],
  [endedThreadId, liveThreadShell(endedThreadId, { activeRunId: null })],
  [
    terminalThreadId,
    {
      ...liveThreadShell(terminalThreadId),
      providerInstanceId: TERMINAL_THREAD_INSTANCE_ID,
      modelSelection: { instanceId: TERMINAL_THREAD_INSTANCE_ID, model: "terminal" },
    },
  ],
]);

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const clientCaller = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

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

const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([Schema.Struct({ ran: Schema.String }), Schema.Struct({ code: Schema.String })]),
  ),
);

const call = (
  tool: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown> = {},
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: tool, arguments: args })),
    Effect.flatMap(({ content }) =>
      decodeOutcome(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.map((outcome) => ("code" in outcome ? outcome.code : outcome.ran)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const supervised = threadCaller(supervisedThreadId);
const plan = threadCaller(planThreadId);
const fullAccess = threadCaller(fullAccessThreadId);
const ended = threadCaller(endedThreadId);
const supervisedClient = clientCaller("approval-required");
const fullAccessClient = clientCaller("full-access");
const readOnlyClient = clientCaller("read-only");
const linkedClient: McpInvocationContext.McpInvocationScope = {
  ...supervisedClient,
  client: { ...supervisedClient.client!, linked: true },
};
// A full-access link's agents can do anything this environment's user can.
const fullAccessLinkedClient: McpInvocationContext.McpInvocationScope = {
  ...fullAccessClient,
  client: { ...fullAccessClient.client!, linked: true },
};
// A call from another machine over an arrow; no machine map here means no arrow allows exec.
const machineSession: McpInvocationContext.McpInvocationScope = {
  ...fullAccessClient,
  requestNamespace: machineRequestNamespace({
    machineId: MachineId.make("vps"),
    sessionId: "session",
  }),
};

const box = EnvironmentId.make("environment-box");
const here = EnvironmentId.make("environment");
const linkedProbe = {
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
  }),
};
const LinkedProbeToolkit = Toolkit.make(
  Tool.make("reads", linkedProbe),
  Tool.make("writes", linkedProbe),
  Tool.make("writes_with_capability", linkedProbe),
  Tool.make("writes_threads", linkedProbe),
  Tool.make("starts_threads", linkedProbe),
  Tool.make("writes_environment", linkedProbe),
);
/** Runs here, and tells whether `environmentId` reached the handler. */
const ranHere = <P extends object>(params: P) =>
  Effect.succeed({ ran: "environmentId" in params ? "saw environmentId" : "here" });

const linkedProbeServer = McpHttpServer.toolkitRegistration(
  LinkedProbeToolkit,
  McpToolAccess.toLayer(LinkedProbeToolkit, {
    reads: McpToolAccess.reads(ranHere),
    writes: McpToolAccess.writes(ranHere),
    writes_with_capability: McpToolAccess.writesWithCapability(ranHere),
    writes_threads: McpToolAccess.writesThreads((input) => [input.threadId], ranHere),
    starts_threads: McpToolAccess.startsThreads((input) => input, ranHere, "stamped"),
    writes_environment: McpToolAccess.writesEnvironment(ranHere),
  }),
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    }),
  ),
  // Stands in for the linked environment, answering with where the call went.
  Layer.provide(
    Layer.mock(PeerForwarding.PeerForwarding)({
      call: (_scope, tool, environmentId) =>
        Effect.succeed({ ran: `${tool.name} in ${environmentId}` } as never),
    }),
  ),
);

it.effect.each([
  ["writes", linkedClient, {}, "capability_denied"],
  ["writes_with_capability", linkedClient, {}, "capability_denied"],
  ["writes", fullAccessLinkedClient, {}, "here"],
  ["writes_with_capability", fullAccessLinkedClient, {}, "here"],

  ["reads", supervised, { environmentId: box }, "reads in environment-box"],
  ["reads", supervised, { environmentId: here }, "here"],
  ["reads", supervised, {}, "here"],

  // The caller is checked here before anything goes.
  ["writes", readOnlyClient, { environmentId: box }, "capability_denied"],
  ["writes", ended, { environmentId: box }, "parent_not_active"],
  ["writes", supervised, { environmentId: box }, "writes in environment-box"],
  ["writes_with_capability", readOnlyClient, { environmentId: box }, "capability_denied"],
  [
    "starts_threads",
    plan,
    { environmentId: box, interactionMode: "default" },
    "interaction_mode_escalation_denied",
  ],
  ["starts_threads", plan, { environmentId: box }, "starts_threads in environment-box"],
  ["writes_environment", supervised, { environmentId: box }, "capability_denied"],
  [
    "writes_environment",
    fullAccess,
    { environmentId: box },
    "writes_environment in environment-box",
  ],
  ["writes_environment", fullAccess, { environmentId: here }, "here"],

  // A thread id names a thread where the call runs, and is checked there.
  [
    "writes_threads",
    supervised,
    { environmentId: box, threadId: fullAccessThreadId },
    "writes_threads in environment-box",
  ],
  [
    "writes_threads",
    supervised,
    { environmentId: here, threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],

  // MM-1923: every write to a terminal thread from another machine needs exec.
  ["writes_threads", machineSession, { threadId: terminalThreadId }, "capability_denied"],
  ["writes_threads", machineSession, { threadId: fullAccessThreadId }, "here"],
  ["writes_threads", fullAccessClient, { threadId: terminalThreadId }, "here"],
] as const)("a linked %s from %o with %o: %s", ([tool, scope, args, expected]) =>
  call(tool, scope, args).pipe(
    Effect.map((outcome) => expect(outcome).toBe(expected)),
    Effect.provide(linkedProbeServer),
  ),
);

it.effect("refuses a linked environment to a tool that acts as its calling thread", () =>
  Effect.gen(function* () {
    const CallerToolkit = Toolkit.make(Tool.make("acts_as_caller", linkedProbe));
    const built = yield* Layer.build(
      McpToolAccess.HandlersLayer.layer(
        McpToolAccess.toLayer(CallerToolkit, {
          acts_as_caller: McpToolAccess.actsAsCaller(ranHere),
        }),
      ),
    ).pipe(Effect.scoped, Effect.exit);
    expect(Exit.isFailure(built) && Cause.hasDies(built.cause)).toBe(true);
  }),
);
