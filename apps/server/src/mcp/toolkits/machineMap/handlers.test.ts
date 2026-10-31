/** Fork: machine map agent tools (MM-801): what an agent hears when a call cannot go through. */
import type { Answer } from "@kitshn/local";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as MachineExec from "../../../fork/machineMap/MachineExec.ts";
import * as KitshnCli from "../../../fork/kitshn/KitshnCli.ts";
import * as KitshnConnection from "../../../fork/kitshn/KitshnConnection.ts";
import { registerAnswer } from "../../../fork/kitshn/KitshnConnection.testkit.ts";
import * as KitshnGrants from "../../../fork/kitshn/KitshnGrants.ts";
import * as KitshnSettingsSync from "../../../fork/kitshn/KitshnSettingsSync.ts";
import * as KitshnProvider from "../../../fork/kitshn/KitshnProvider.ts";
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

/** The owner in a shell: `t3 tool call` has no thread. */
const ownerCaller: McpInvocationContext.McpInvocationScope = {
  ...threadCaller,
  thread: undefined,
  client: { sessionId: "cli", label: "CLI (local user)", access: "full-access" },
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

type Answering = (input: KitshnConnection.LocalRequestInput) => Effect.Effect<Answer>;

/** The daemon's answers; without one, this server has no connection to kitshn. */
const toolsWith = (
  threads: Layer.Layer<ThreadManagement.ThreadManagementService>,
  requests: Array<unknown> = [],
  answer?: Answering,
) => {
  const provider = {
    state: Stream.make({
      settings: { shared: { server: { a: 1 }, client: {} }, machine: null },
      cardSettings: {},
      reach: [],
      syncedAt: null,
      paused: false,
      problems: [],
    }),
    connection: Stream.make({ status: "connecting" as const, detail: "kitshn provider stopped" }),
    linkSocket: Effect.succeed(null),
    askResults: Effect.succeed([]),
    jobResults: Effect.succeed([]),
  } satisfies Partial<KitshnProvider.KitshnProvider["Service"]>;
  const layerKitshn = Layer.effect(
    KitshnConnection.KitshnConnection,
    Effect.gen(function* () {
      const connection = yield* KitshnConnection.make;
      if (answer === undefined) return connection;
      yield* connection.attach({
        answer: registerAnswer(),
        request: (input) =>
          Effect.gen(function* () {
            requests.push(input);
            // K-709: kitshn stored the part, so the next `desired` event echoes its rev.
            if (input.type === "desired-set") {
              yield* connection.publish({
                type: "desired",
                kind: input.kind,
                state: { shared: null, machine: null },
                rev: input.rev ?? null,
              });
            }
            return yield* answer(input);
          }),
        notify: () => Effect.void,
      });
      return connection;
    }),
  );
  return McpHttpServer.toolkitRegistration(MachineMapToolkit, MachineMapHandlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(threads),
    Layer.provide(Layer.mock(KitshnProvider.KitshnProvider)(provider)),
    // The real rule of the settings service, on the fake daemon connection.
    Layer.provide(
      Layer.effect(
        KitshnSettingsSync.KitshnSettingsSync,
        Effect.map(KitshnConnection.KitshnConnection, (kitshn) =>
          KitshnSettingsSync.KitshnSettingsSync.of({
            setOne: KitshnSettingsSync.makeSetOne(provider, kitshn, Effect.succeed("rev-1")),
          } as unknown as KitshnSettingsSync.KitshnSettingsSync["Service"]),
        ),
      ),
    ),
    Layer.provideMerge(layerKitshn),
    Layer.provide(
      Layer.mock(KitshnGrants.KitshnGrants)({
        machine: Effect.succeed(null),
        trustsPeerOrigin: () => false,
        peerOrigins: () => [],
      }),
    ),
    Layer.provide(Layer.mock(KitshnCli.KitshnCli)({})),
    Layer.provide(Layer.mock(MachineExec.MachineExec)({ lateResults: Stream.make([]) })),
  );
};

const layerTools = toolsWith(liveThreadsLayer);

it.effect("machines_read shows the connection when kitshn cannot answer (K-1611)", () =>
  Effect.gen(function* () {
    const result = yield* callTool(threadCaller, "machines_read", {});
    expect(result.isError).not.toBe(true);
    expect(resultText(result)).toContain("no connection to kitshn");
    expect(resultText(result)).toContain("kitshn provider stopped");
  }).pipe(Effect.provide(layerTools)),
);

it.effect("another machine cannot use the machine tools of this machine", () =>
  Effect.gen(function* () {
    for (const [name, args] of [
      ["machines_read", {}],
      ["machines_resources", {}],
    ] as const) {
      const result = yield* callTool(machineCaller, name, args);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("not available to another machine");
    }
  }).pipe(Effect.provide(layerTools)),
);

it.effect("a plan thread cannot change anything, and a full-access one sends a kitshn job", () =>
  Effect.gen(function* () {
    const requests: Array<unknown> = [];
    const done: Answering = () =>
      Effect.succeed({ id: "1", type: "ask", outcome: "done", result: { jobId: 7 } });
    const restrictedTools = toolsWith(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(liveThreadShell(id, { interactionMode: "plan" })),
      }),
      requests,
      done,
    );
    for (const [tool, input] of [
      [
        "machines_set_setting",
        { part: "shared", scope: "server", key: "forkAutoUpdate", value: true },
      ],
      ["machines_command", { machineId: "vps", command: "restart-server" }],
      ["machines_queue_cancel", { jobId: 7 }],
    ] as const) {
      const result = yield* callTool(threadCaller, tool, input).pipe(
        Effect.provide(restrictedTools),
      );
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("full-access/default");
    }
    expect(requests).toEqual([]);
    const allowed = yield* callTool(threadCaller, "machines_command", {
      machineId: "vps",
      command: "restart-server",
    }).pipe(Effect.provide(toolsWith(liveThreadsLayer, requests, done)));
    expect(allowed.isError).not.toBe(true);
    expect(requests).toEqual([
      {
        type: "ask",
        action: "job",
        target: "vps",
        body: {
          command: { kind: "provider", provider: "t3", command: "restart-server", resource: "app" },
        },
      },
    ]);
  }),
);

it.effect("a setting goes into one part of the settings state, keeping its other keys", () =>
  Effect.gen(function* () {
    const requests: Array<unknown> = [];
    const done: Answering = () => Effect.succeed({ id: "1", type: "desired-set" });
    const tools = toolsWith(liveThreadsLayer, requests, done);
    // The shared part reaches every machine, so an agent thread never sets it; the owner does.
    const agent = yield* callTool(threadCaller, "machines_set_setting", {
      part: "shared",
      scope: "server",
      key: "forkAutoUpdate",
      value: true,
    }).pipe(Effect.provide(tools));
    expect(resultText(agent)).toContain("Agents do not change the shared settings");
    expect(requests).toEqual([]);
    const set = yield* callTool(ownerCaller, "machines_set_setting", {
      part: "shared",
      scope: "server",
      key: "forkAutoUpdate",
      value: true,
    }).pipe(Effect.provide(tools));
    expect(set.isError).not.toBe(true);
    expect(requests).toEqual([
      {
        type: "desired-set",
        provider: "t3",
        kind: "t3.settings",
        part: "shared",
        value: { server: { a: 1, forkAutoUpdate: true }, client: {} },
        rev: "rev-1",
      },
    ]);
    const local = yield* callTool(threadCaller, "machines_set_setting", {
      part: "machine",
      scope: "server",
      key: "worktreesDirectory",
      value: "/tmp",
    }).pipe(Effect.provide(tools));
    expect(resultText(local)).toContain("belongs to one machine");
  }),
);

it.effect("a job that waits for its approver circle names kitshn's proposal id (K-1722)", () =>
  Effect.gen(function* () {
    const waiting: Answering = () =>
      Effect.succeed({ id: "1", type: "ask", outcome: "waiting", proposalId: "p-9" });
    const result = yield* callTool(threadCaller, "machines_command", {
      machineId: "vps",
      command: "restart-server",
    }).pipe(Effect.provide(toolsWith(liveThreadsLayer, [], waiting)));
    expect(resultText(result)).toContain('\\"proposalId\\":\\"p-9\\"');
  }),
);
