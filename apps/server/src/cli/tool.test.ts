import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { withThreadCredential } from "@t3tools/provider-core/server/forkThreadCredential";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Tool } from "effect/ai";
import { GlobalFlag } from "effect/cli";

import { McpToolkits } from "../mcp/toolkits/registry.ts";
import { resolveCliAuthConfig } from "./config.ts";
import { applyCallerThread, callOnServer, findMcpTool } from "./tool.ts";

const registryToolNames = () =>
  Object.values(McpToolkits)
    .flatMap((toolkit) => Object.values(toolkit.tools).map((tool) => tool.name))
    .toSorted();

it.effect("describes every registry tool with its MCP input schema", () =>
  Effect.gen(function* () {
    for (const toolkit of Object.values(McpToolkits)) {
      for (const tool of Object.values(toolkit.tools)) {
        const entry = yield* findMcpTool(tool.name);
        expect(entry.inputSchema).toEqual(Tool.getJsonSchema(tool));
      }
    }
    expect(registryToolNames()).toContain("t3_thread_organize");
  }),
);

it.effect("rejects a tool that is not in the registry", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(findMcpTool("not_a_tool"));
    expect(error.message).toContain("t3 tool list");
  }),
);

it.effect("requires a thread for thread-bound tools without a thread credential", () =>
  Effect.gen(function* () {
    const tool = yield* findMcpTool("t3_thread_organize");
    const error = yield* Effect.flip(
      applyCallerThread({
        tool,
        arguments: { action: "pin" },
        thread: Option.none(),
        hasThreadCredential: false,
      }),
    );
    expect(error.message).toContain("--thread");
  }),
);

it.effect("fills the thread from --thread and keeps an explicit threadId", () =>
  Effect.gen(function* () {
    const tool = yield* findMcpTool("t3_thread_organize");
    const filled = yield* applyCallerThread({
      tool,
      arguments: { action: "pin" },
      thread: Option.some("thread-a"),
      hasThreadCredential: false,
    });
    expect(filled.threadId).toBe("thread-a");
    const explicit = yield* applyCallerThread({
      tool,
      arguments: { action: "pin", threadId: "thread-b" },
      thread: Option.some("thread-a"),
      hasThreadCredential: false,
    });
    expect(explicit.threadId).toBe("thread-b");
  }),
);

it.effect("lets a thread credential omit the thread", () =>
  Effect.gen(function* () {
    const tool = yield* findMcpTool("t3_thread_organize");
    const result = yield* applyCallerThread({
      tool,
      arguments: { action: "pin" },
      thread: Option.none(),
      hasThreadCredential: true,
    });
    expect(result.threadId).toBeUndefined();
  }),
);

/** Calls `callOnServer` with `env` as the shell environment, and returns the connections it used. */
const callWith = (env: NodeJS.ProcessEnv, baseDir: Option.Option<string>) => {
  const connections: Array<unknown> = [];
  return callOnServer({ baseDir }, (connection) =>
    Effect.sync(() => void connections.push(connection)),
  ).pipe(
    Effect.as(connections),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
    Effect.provideService(GlobalFlag.LogLevel, Option.none()),
  );
};

/** A T3 home whose server runs at `origin`, as its runtime state file says. */
const homeServedAt = Effect.fn("homeServedAt")(function* (origin: string | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped();
  if (origin === undefined) return baseDir;
  const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none());
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(config.serverRuntimeStatePath), { recursive: true });
  yield* fs.writeFileString(
    config.serverRuntimeStatePath,
    JSON.stringify({
      version: 1,
      pid: 1,
      port: Number(new URL(origin).port),
      origin,
      startedAt: "2026-10-23T00:00:00.000Z",
    }),
  );
  return baseDir;
});

const liveShell = withThreadCredential(
  {},
  { endpoint: "http://127.0.0.1:43123/mcp", authorizationHeader: "Bearer thread-a" },
);
const asThread = {
  endpoint: "http://127.0.0.1:43123/mcp",
  authorization: "Bearer thread-a",
  hasThreadCredential: true,
};

it.effect("an agent shell calls as its thread when no --base-dir is given (MM-1920)", () =>
  Effect.gen(function* () {
    expect(yield* callWith(liveShell, Option.none())).toEqual([asThread]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer))),
);

it.effect("a thread credential with a --base-dir of another server fails loudly", () =>
  Effect.gen(function* () {
    // The incident: a dev server's home, called from a shell of a thread of the live server.
    const devHome = yield* homeServedAt("http://127.0.0.1:5735");
    const toDev = yield* Effect.flip(callWith(liveShell, Option.some(devHome)));
    expect(toDev.message).toContain(`--base-dir ${devHome} targets http://127.0.0.1:5735`);
    expect(toDev.message).toContain("thread credential targets http://127.0.0.1:43123");
    expect(toDev.message).toContain("Unset T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION");
    const stopped = yield* Effect.flip(
      callWith(liveShell, Option.some(yield* homeServedAt(undefined))),
    );
    expect(stopped.message).toContain("targets no running T3 server");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer))),
);

it.effect("a thread credential with a T3CODE_HOME of another server fails loudly", () =>
  Effect.gen(function* () {
    const devHome = yield* homeServedAt("http://127.0.0.1:5735");
    const toDev = yield* Effect.flip(
      callWith({ ...liveShell, T3CODE_HOME: devHome }, Option.none()),
    );
    expect(toDev.message).toContain(`T3CODE_HOME ${devHome} targets http://127.0.0.1:5735`);
    // A home of the credential's own server is fine, as in an agent shell of a dev server.
    const ownHome = yield* homeServedAt("http://127.0.0.1:43123");
    expect(yield* callWith({ ...liveShell, T3CODE_HOME: ownHome }, Option.none())).toEqual([
      asThread,
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer))),
);

it.effect("an empty credential is unset, and an endpoint that is no URL fails", () =>
  Effect.gen(function* () {
    const empty = yield* Effect.flip(
      callWith(
        { T3_ACP_MCP_ENDPOINT: "", T3_ACP_MCP_AUTHORIZATION: "" },
        Option.some(yield* homeServedAt(undefined)),
      ),
    );
    expect(empty.message).toContain("server is not running");
    const malformed = yield* Effect.flip(
      callWith(
        { T3_ACP_MCP_ENDPOINT: "not a url", T3_ACP_MCP_AUTHORIZATION: "Bearer thread-a" },
        Option.none(),
      ),
    );
    expect(malformed.message).toContain("T3_ACP_MCP_ENDPOINT is not a URL");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer))),
);

it.effect("a thread credential with a --base-dir of its own server calls as the thread", () =>
  Effect.gen(function* () {
    // The runtime state names the configured host, the credential the bound address.
    const ownHome = yield* homeServedAt("http://localhost:43123");
    expect(yield* callWith(liveShell, Option.some(ownHome))).toEqual([asThread]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer))),
);

it.effect("without a thread credential, --base-dir picks that home's server", () =>
  Effect.gen(function* () {
    const devHome = yield* homeServedAt("http://127.0.0.1:5735");
    const [connection] = yield* callWith({}, Option.some(devHome));
    expect(connection).toMatchObject({
      endpoint: "http://127.0.0.1:5735/mcp",
      hasThreadCredential: false,
    });
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer))),
);

it.effect("half a thread credential fails instead of falling back", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      callWith({ T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:43123/mcp" }, Option.none()),
    );
    expect(error.message).toContain("Only one of T3_ACP_MCP_ENDPOINT");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer))),
);
