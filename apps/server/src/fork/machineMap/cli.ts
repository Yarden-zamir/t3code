/**
 * Fork: `t3 machine-map join <code> [--portal <url>]` (MM-203). It calls the tool
 * `machines_join` on the running server, so the CLI, the agent tool and T3 Settings share one
 * service method. The server must run.
 *
 * `t3 machine exec <machine> -- <command>` (MM-1919) runs a command on another machine like ssh,
 * through the stream route of the running server.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { MACHINE_EXEC_STREAM_PATH } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import { Argument, Command, Flag } from "effect/cli";

import { projectLocationFlags } from "../../cli/config.ts";
import { ToolCliError, callOnServer } from "../../cli/tool.ts";
import { callAcpMcpTool } from "../../mcp/AcpMcpStdioBridge.ts";
import {
  EXIT_FAILED,
  type ExecClientResult,
  openExecSocket,
  runExecClient,
  streamUrl,
} from "./machineExecStream.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
/** A failed tool returns its error as JSON text, for example an `OrchestratorMcpFailure`. */
const decodeFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
);
const ToolContent = Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String }));
const decodeContent = Schema.decodeUnknownOption(ToolContent);

const failureMessage = (content: unknown): string =>
  Option.match(decodeContent(content), {
    onNone: () => encodeJson(content ?? null),
    onSome: ([first]) =>
      first === undefined
        ? "no details"
        : Option.match(decodeFailure(first.text), {
            onNone: () => first.text,
            onSome: (failure) => failure.message,
          }),
  });

const joinCommand = Command.make("join", {
  ...projectLocationFlags,
  code: Argument.String("code").pipe(
    Argument.withDescription("The one-time join code from Add machine in the portal."),
  ),
  portal: Flag.String("portal").pipe(
    Flag.withDescription("Portal URL. Defaults to the portal of the machineMap setting."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Join this machine to the machine map with a one-time code from Add machine in the portal. The T3 server must run. It saves the machine token, turns on the machineMap setting and connects.",
  ),
  Command.withExamples([
    { command: "t3 machine-map join K7QM-2XPA", description: "Join the portal of the setting." },
    {
      command: "t3 machine-map join K7QM-2XPA --portal https://t3.yarden-zamir.com",
      description: "Join a given portal.",
    },
  ]),
  Command.withHandler((flags) =>
    callOnServer(flags, (connection) =>
      Effect.gen(function* () {
        const result = yield* callAcpMcpTool({
          endpoint: connection.endpoint,
          authorization: connection.authorization,
          tool: "machines_join",
          arguments: {
            code: flags.code,
            ...(Option.isSome(flags.portal) ? { portalUrl: flags.portal.value } : {}),
          },
        }).pipe(Effect.mapError((cause) => new ToolCliError({ detail: cause.message })));
        const envelope = (typeof result === "object" && result !== null ? result : {}) as {
          readonly isError?: unknown;
          readonly content?: unknown;
        };
        if (envelope.isError === true) {
          return yield* new ToolCliError({
            detail: `Join failed: ${failureMessage(envelope.content)}`,
          });
        }
        yield* Console.log("Joined the machine map. The server connects to the portal now.");
      }),
    ),
  ),
);

/** A reader that stops early, such as `head`, ends the CLI like SIGPIPE does: 128 + 13, quietly. */
const EXIT_BROKEN_PIPE = 141;

const writeFailure = (error: Error): ExecClientResult =>
  "code" in error && error.code === "EPIPE"
    ? { exitCode: EXIT_BROKEN_PIPE }
    : { exitCode: EXIT_FAILED, message: `Could not write the output: ${error.message}` };

/** Writes raw bytes and waits until the stream takes them: the backpressure of the output. */
const writeTo = (stream: NodeJS.WriteStream) => {
  // The write callback reports a failure; the "error" event would end the process instead.
  stream.on("error", () => {});
  return (bytes: Uint8Array) =>
    Effect.callback<void, ExecClientResult>((resume) => {
      stream.write(bytes, (error) =>
        resume(
          error === null || error === undefined ? Effect.void : Effect.fail(writeFailure(error)),
        ),
      );
    });
};

const execCommand = Command.make("exec", {
  ...projectLocationFlags,
  machine: Argument.String("machine").pipe(
    Argument.withDescription("Id or name of the other machine, as machines_read lists it."),
  ),
  cwd: Flag.String("cwd").pipe(
    Flag.withDescription(
      "Working directory on that machine: an absolute path, or a path that starts with ~. Defaults to the home directory.",
    ),
    Flag.optional,
  ),
  timeout: Flag.Int("timeout").pipe(
    Flag.withDescription("Seconds before the command stops, with exit code 124. Defaults to none."),
    Flag.optional,
  ),
  command: Argument.String("command").pipe(
    Argument.withDescription(
      "The command after --. Its words are joined with spaces and run by the shell of that machine: $SHELL -c, or Windows PowerShell.",
    ),
    Argument.variadic({ min: 1 }),
  ),
}).pipe(
  Command.withDescription(
    "Run a command on another machine of the machine map, like ssh. Stdin goes to the command, stdout and stderr come back as they are written, and the exit code is the command's. A timeout exits 124. A refusal, a lost connection, or an arrow that stops allowing exec exits 255. In an agent's shell it acts as the agent's thread, with the limits of that thread. It needs an arrow with exec to that machine.",
  ),
  Command.withExamples([
    { command: "t3 machine exec vps -- uname -a", description: "Run one command." },
    {
      command: "t3 machine exec vps -- cat /var/log/app.log | grep error",
      description: "Use the output in a local pipe.",
    },
    {
      command: "tar c -C dist . | t3 machine exec vps -- tar x -C /srv/app",
      description: "Copy a folder to the other machine.",
    },
    {
      command: "t3 machine exec vps -- tar c -C /srv/app . | tar x -C ./backup",
      description: "Copy a folder from the other machine.",
    },
  ]),
  Command.withHandler(
    Effect.fn("machineExecCommand")(function* (flags) {
      const timeoutSeconds = Option.getOrUndefined(flags.timeout);
      const run = callOnServer(flags, (connection) =>
        Effect.gen(function* () {
          if (timeoutSeconds !== undefined && timeoutSeconds < 1) {
            return yield* new ToolCliError({
              detail: "--timeout takes a number of seconds above 0.",
            });
          }
          const socket = yield* openExecSocket(
            streamUrl(connection.endpoint, MACHINE_EXEC_STREAM_PATH),
            { authorization: connection.authorization },
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ToolCliError({
                  detail: `The local T3 server did not open the exec stream: ${cause.message} It may run a version without t3 machine exec.`,
                }),
            ),
          );
          const stdio = yield* Stdio.Stdio;
          return yield* runExecClient({
            socket,
            start: {
              type: "start",
              machine: flags.machine,
              command: flags.command.join(" "),
              ...(Option.isSome(flags.cwd) ? { cwd: flags.cwd.value } : {}),
              ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
            },
            stdin: stdio.stdin,
            stdout: writeTo(process.stdout),
            stderr: writeTo(process.stderr),
          });
        }).pipe(Effect.scoped, Effect.provide(NodeSocket.layerWebSocketConstructor)),
      );
      const result = yield* run.pipe(
        Effect.catch((error): Effect.Effect<ExecClientResult> =>
          Effect.succeed({ exitCode: EXIT_FAILED, message: error.message }),
        ),
      );
      if (result.message !== undefined) yield* Console.error(`t3 machine exec: ${result.message}`);
      // The process ends with the code of the command. Stdin can still be open, for example a
      // terminal, or a pipe that the command never read to its end, so it must not hold the process.
      process.exitCode = result.exitCode;
      process.stdin.destroy();
    }),
  ),
);

/** Fork: `t3 machine`, commands on other machines of the machine map (MM-1919). */
export const machineCommand = Command.make("machine").pipe(
  Command.withDescription(
    "Fork: work on other machines of the machine map. See docs/fork-agents.md.",
  ),
  Command.withExamples([
    { command: "t3 machine exec vps -- uname -a", description: "Run a command on vps." },
  ]),
  Command.withSubcommands([execCommand]),
);

export const machineMapCommand = Command.make("machine-map").pipe(
  Command.withDescription(
    "Fork: the machine map of T3 servers. Agents use the machines_* MCP tools; see docs/fork-agents.md.",
  ),
  Command.withExamples([
    { command: "t3 machine-map join K7QM-2XPA", description: "Join this machine to the map." },
  ]),
  Command.withSubcommands([joinCommand]),
);
