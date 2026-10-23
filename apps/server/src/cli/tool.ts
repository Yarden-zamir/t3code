import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import {
  THREAD_CREDENTIAL_AUTHORIZATION_ENV,
  THREAD_CREDENTIAL_ENDPOINT_ENV,
} from "@t3tools/provider-core/server/forkThreadCredential";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { callAcpMcpTool } from "../mcp/AcpMcpStdioBridge.ts";
import { listMcpTools, type McpToolEntry } from "../mcp/toolkits/registry.ts";
import { CLI_LOCAL_USER_LABEL } from "../fork/machineMap/machineAccess.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { T3_TERMINAL_THREAD_ID_ENV } from "../terminal/terminalEnv.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class ToolCliError extends Schema.TaggedError<ToolCliError>()("ToolCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (detail: string) => Effect.fail(new ToolCliError({ detail }));

/** The parameter that every thread-bound MCP tool takes; omitted, it means the caller's thread. */
const THREAD_PARAMETER = "threadId";

const toolEnvironment = Config.all({
  endpoint: Config.String(THREAD_CREDENTIAL_ENDPOINT_ENV).pipe(Config.option),
  authorization: Config.String(THREAD_CREDENTIAL_AUTHORIZATION_ENV).pipe(Config.option),
  terminalThread: Config.String(T3_TERMINAL_THREAD_ID_ENV).pipe(Config.option),
});

export const findMcpTool = (name: string) => {
  const tool = listMcpTools().find((entry) => entry.name === name);
  return tool === undefined
    ? fail(`Unknown tool "${name}". Run \`t3 tool list\` to see the available tools.`)
    : Effect.succeed(tool);
};

const takesThread = (tool: McpToolEntry) => {
  const properties = tool.inputSchema.properties;
  return typeof properties === "object" && properties !== null && THREAD_PARAMETER in properties;
};

/**
 * Fills `threadId` for thread-bound tools. A caller with its own thread
 * credential (an agent shell) may omit it; any other caller has no thread,
 * so the thread must come from `--thread` or the T3 terminal environment.
 */
export const applyCallerThread = (input: {
  readonly tool: McpToolEntry;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly thread: Option.Option<string>;
  readonly hasThreadCredential: boolean;
}) => {
  if (!takesThread(input.tool) || input.arguments[THREAD_PARAMETER] !== undefined) {
    return Effect.succeed(input.arguments);
  }
  if (Option.isSome(input.thread)) {
    return Effect.succeed({ ...input.arguments, [THREAD_PARAMETER]: input.thread.value });
  }
  return input.hasThreadCredential
    ? Effect.succeed(input.arguments)
    : fail(
        `Tool "${input.tool.name}" acts on a thread. Pass --thread <id>, set "${THREAD_PARAMETER}" in the input, or run it inside a T3 Code terminal.`,
      );
};

const decodeArguments = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const readArguments = Effect.fn("readToolArguments")(function* (flags: {
  readonly input: Option.Option<string>;
  readonly inputFile: Option.Option<string>;
}) {
  if (Option.isSome(flags.input) && Option.isSome(flags.inputFile)) {
    return yield* fail("Pass --input or --input-file, not both.");
  }
  const fs = yield* FileSystem.FileSystem;
  const text = yield* Option.match(flags.inputFile, {
    onNone: () => Effect.succeed(Option.getOrElse(flags.input, () => "{}")),
    onSome: (path) =>
      fs
        .readFileString(path)
        .pipe(Effect.mapError(() => new ToolCliError({ detail: `Could not read ${path}.` }))),
  });
  return yield* decodeArguments(text).pipe(
    Effect.mapError(() => new ToolCliError({ detail: "Tool input must be a JSON object." })),
  );
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const printJson = (value: unknown) => Console.log(encodeJson(value));

/** Host names that reach the same server on this machine. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Whether two URLs reach the same server: the same port, and the same host or both loopback. */
const sameServer = (left: string, right: string) => {
  const host = (url: URL) => (LOOPBACK_HOSTS.has(url.hostname) ? "loopback" : url.hostname);
  const [a, b] = [new URL(left), new URL(right)];
  return a.port === b.port && host(a) === host(b);
};

/**
 * Calls one tool on the running server. An agent shell reuses its thread
 * credential (MM-1920); otherwise the CLI issues a short-lived MCP client
 * session from the local auth store and revokes it after the call.
 *
 * An explicit `--base-dir` is never ignored: with a thread credential, it must
 * name the server of that credential, so a call meant for a dev server never
 * reaches the live server as the agent's thread.
 */
export const callOnServer = Effect.fn("callToolOnServer")(function* <A, R>(
  flags: { readonly baseDir: Option.Option<string> },
  run: (connection: {
    readonly endpoint: string;
    readonly authorization: string;
    readonly hasThreadCredential: boolean;
  }) => Effect.Effect<A, ToolCliError, R>,
) {
  const environment = yield* toolEnvironment;
  const endpoint = Option.getOrUndefined(environment.endpoint);
  const authorization = Option.getOrUndefined(environment.authorization);
  if ((endpoint === undefined) !== (authorization === undefined)) {
    return yield* fail(
      `Only one of ${THREAD_CREDENTIAL_ENDPOINT_ENV} and ${THREAD_CREDENTIAL_AUTHORIZATION_ENV} is set. Set both, or unset both.`,
    );
  }
  const credential =
    endpoint !== undefined && authorization !== undefined
      ? { endpoint, authorization, hasThreadCredential: true }
      : undefined;
  if (credential !== undefined && Option.isNone(flags.baseDir)) return yield* run(credential);
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (credential !== undefined && Option.isSome(flags.baseDir)) {
    const target = Option.getOrUndefined(runtimeState)?.origin;
    if (target === undefined || !sameServer(target, credential.endpoint)) {
      return yield* fail(
        `--base-dir ${flags.baseDir.value} targets ${target ?? "no running T3 server"}, but this shell's thread credential targets ${new URL(credential.endpoint).origin}. Unset ${THREAD_CREDENTIAL_ENDPOINT_ENV} and ${THREAD_CREDENTIAL_AUTHORIZATION_ENV} to call a dev server.`,
      );
    }
    return yield* run(credential);
  }
  if (Option.isNone(runtimeState)) {
    return yield* fail("T3 Code server is not running. Start it, then run this again.");
  }
  const localEndpoint = new URL("/mcp", runtimeState.value.origin).toString();
  return yield* Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* Effect.acquireUseRelease(
      auth.issueMcpClientSession({
        // The History of the machine map names a caller without a thread by this label, and
        // cross-machine calls refuse it (MM-1920).
        label: CLI_LOCAL_USER_LABEL,
        // The CLI already holds the local auth store, so it gets the widest ceiling.
        access: "full-access",
        peerLink: false,
        client: { deviceType: "bot" },
      }),
      (issued) =>
        run({
          endpoint: localEndpoint,
          authorization: `Bearer ${issued.token}`,
          hasThreadCredential: false,
        }),
      (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
  }).pipe(
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});

const toolListCommand = Command.make("list").pipe(
  Command.withDescription(
    "List the MCP tools as JSON: the name and description of each. Works without a running server.",
  ),
  Command.withExamples([
    { command: "t3 tool list", description: "Print every tool name and description." },
  ]),
  Command.withHandler(() =>
    printJson(listMcpTools().map(({ name, description }) => ({ name, description }))),
  ),
);

const toolDescribeCommand = Command.make("describe", {
  name: Argument.String("name").pipe(Argument.withDescription("Tool name.")),
}).pipe(
  Command.withDescription(
    "Print a tool's description and input JSON schema. Works without a running server.",
  ),
  Command.withExamples([
    { command: "t3 tool describe machines_command", description: "Show the input of one tool." },
  ]),
  Command.withHandler(({ name }) => findMcpTool(name).pipe(Effect.flatMap(printJson))),
);

const toolCallCommand = Command.make("call", {
  ...projectLocationFlags,
  name: Argument.String("name").pipe(Argument.withDescription("Tool name.")),
  input: Flag.String("input").pipe(
    Flag.withDescription("Tool input as a JSON object."),
    Flag.optional,
  ),
  inputFile: Flag.String("input-file").pipe(
    Flag.withDescription("Path to a file that holds the tool input as a JSON object."),
    Flag.optional,
  ),
  thread: Flag.String("thread").pipe(
    Flag.withDescription(
      `Thread for thread-bound tools. Defaults to ${T3_TERMINAL_THREAD_ID_ENV} inside a T3 Code terminal.`,
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Call a tool on the running T3 Code server and print its result as JSON. The tool has its normal side effects. In an agent's shell the call acts as the agent's thread, with the limits of that thread. Elsewhere, also in a T3 Code terminal, it uses a short full-access session that ends after the call and reaches no other machine. With a thread credential, --base-dir must name the server of that credential.",
  ),
  Command.withExamples([
    { command: "t3 tool call t3_thread_list", description: "Call a tool without input." },
    {
      command: `t3 tool call t3_thread_list --input '{"environmentId":"<environmentId>"}'`,
      description:
        "Call a tool on another machine of the machine map. t3_environment_links lists their environment ids.",
    },
    {
      command: "t3 tool call t3_thread_read --thread <threadId>",
      description: "Call a thread-bound tool outside a T3 Code terminal.",
    },
  ]),
  Command.withHandler(
    Effect.fn("toolCallCommand")(function* (flags) {
      const tool = yield* findMcpTool(flags.name);
      const parsed = yield* readArguments(flags);
      const environment = yield* toolEnvironment;
      const thread = Option.orElse(flags.thread, () => environment.terminalThread);
      yield* callOnServer(flags, (connection) =>
        Effect.gen(function* () {
          const toolArguments = yield* applyCallerThread({
            tool,
            arguments: parsed,
            thread,
            hasThreadCredential: connection.hasThreadCredential,
          });
          const result = yield* callAcpMcpTool({
            endpoint: connection.endpoint,
            authorization: connection.authorization,
            tool: tool.name,
            arguments: toolArguments,
          }).pipe(Effect.mapError((cause) => new ToolCliError({ detail: cause.message })));
          const envelope = (typeof result === "object" && result !== null ? result : {}) as {
            readonly isError?: unknown;
            readonly structuredContent?: unknown;
            readonly content?: unknown;
          };
          if (envelope.isError === true) {
            return yield* fail(
              `Tool "${tool.name}" failed: ${encodeJson(envelope.content ?? result)}`,
            );
          }
          yield* printJson(envelope.structuredContent ?? envelope.content ?? result);
        }),
      );
    }),
  ),
);

export const toolCommand = Command.make("tool").pipe(
  Command.withDescription(
    "List, describe, and call T3 Code MCP tools: the same tools that agents get over MCP.",
  ),
  Command.withExamples([
    { command: "t3 tool list", description: "List the tools." },
    { command: "t3 tool describe machines_read", description: "Show one tool." },
    { command: "t3 tool call machines_read", description: "Call one tool." },
  ]),
  Command.withSubcommands([toolListCommand, toolDescribeCommand, toolCallCommand]),
);
