/** Fork: machine map agent tools (MM-801): what an agent hears when a call cannot go through. */
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as MachineExec from "../../../fork/machineMap/MachineExec.ts";
import * as MachineMap from "../../../fork/machineMap/MachineMap.ts";
import * as MachinePeers from "../../../fork/machineMap/MachinePeers.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as MachineMapHandlers from "./handlers.ts";
import { MachineMapToolkit } from "./tools.ts";

const threadCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:machine-map-tools"),
  requestNamespace: "provider:machine-map-tools",
  thread: {
    threadId: ThreadId.make("thread:machine-map-tools"),
    providerSessionId: "provider:machine-map-tools",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

const machineCaller: McpInvocationContext.McpInvocationScope = {
  ...threadCaller,
  requestNamespace: "machine-session:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "machine VPS", access: "full-access" },
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "machine-map", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "machine-map", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const callTool = (
  caller: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  });

const resultText = (result: { readonly content: ReadonlyArray<unknown> }) =>
  JSON.stringify(result.content);

const toolsWith = (
  threads: Layer.Layer<ThreadManagement.ThreadManagementService>,
  callMapTool: MachineMap.MachineMap["Service"]["callMapTool"] = () =>
    Effect.fail(
      new MachineMap.MachineMapToolError({
        reason: "not-connected",
        detail: "This machine has no portal connection now.",
      }),
    ),
) =>
  McpHttpServer.toolkitRegistration(MachineMapToolkit, MachineMapHandlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(threads),
    Layer.provide(
      Layer.mock(MachineMap.MachineMap)({
        callMapTool,
      }),
    ),
    Layer.provide(Layer.mock(MachinePeers.MachinePeers)({ machineOf: () => undefined })),
    Layer.provide(Layer.mock(MachineExec.MachineExec)({})),
  );

const layerTools = toolsWith(liveThreadsLayer);

it.effect("a map tool without a portal connection says so", () =>
  Effect.gen(function* () {
    const result = yield* callTool(threadCaller, "machines_read", {});
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("no portal connection");
  }).pipe(Effect.provide(layerTools)),
);

it.effect("another machine cannot use the map tools of this machine", () =>
  Effect.gen(function* () {
    for (const [name, args] of [
      ["machines_read", {}],
      ["machines_resources", { machineId: "mac" }],
    ] as const) {
      const result = yield* callTool(machineCaller, name, args);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("not available to another machine");
    }
  }).pipe(Effect.provide(layerTools)),
);

it.effect("the machine's edit role does not let a plan thread change the map", () =>
  Effect.gen(function* () {
    const portalCalls: Array<string> = [];
    const editPortal: MachineMap.MachineMap["Service"]["callMapTool"] = ({ tool }) =>
      Effect.sync(() => {
        portalCalls.push(tool);
        return { _tag: "applied", revision: 2 };
      });
    const restrictedTools = toolsWith(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id, { interactionMode: "plan" })),
      }),
      editPortal,
    );
    for (const [tool, input] of [
      ["machines_set_access", { from: "mac", to: "vps", level: "admin" }],
      ["machines_set_setting", { scope: "server", key: "forkAutoUpdate", value: true }],
      ["machines_command", { machineId: "vps", command: { _tag: "restartServer" } }],
      ["machines_queue_cancel", { commandId: "command:queued" }],
      ["machines_undo", { revision: 1 }],
      ["machines_preset", { action: "apply", name: "full-access" }],
    ] as const) {
      const result = yield* callTool(threadCaller, tool, input).pipe(
        Effect.provide(restrictedTools),
      );
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("full-access/default");
    }
    expect(portalCalls).toEqual([]);
    const allowed = yield* callTool(threadCaller, "machines_command", {
      machineId: "vps",
      command: { _tag: "restartServer" },
    }).pipe(Effect.provide(toolsWith(liveThreadsLayer, editPortal)));
    expect(allowed.isError).not.toBe(true);
    expect(portalCalls).toEqual(["machines_command"]);
  }),
);
