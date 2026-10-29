/**
 * Fork: the contract between a T3 server and its own clients for kitshn (K-704 to K-1609).
 * `machineMap.subscribe` sends the whole state on each change. The RPC names stay from the
 * machine map.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ScopedSettingValues, SettingValues } from "./machineMap.ts";

/** What a client needs of this server's kitshn connection. */
export const MachineMapClientState = Schema.Struct({
  /** kitshn answered a `register` of this server, so it is a kitshn provider (K-704). */
  joined: Schema.Boolean,
  /** This machine on the kitshn map; the name is null before the daemon reached kitshn. */
  machine: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) })),
  /** K-709: the effective `t3.settings`: the shared part with this machine's part over it. */
  settings: ScopedSettingValues,
  /** K-1623: this machine's T3 host is not with kitshn yet; run the host handover for it. */
  hostNotWithKitshn: Schema.Boolean,
});
export type MachineMapClientState = typeof MachineMapClientState.Type;

/**
 * MM-1907: an environment whose threads the agents of this server can read: the server itself,
 * then each machine that a kitshn link reaches now.
 */
export const MachineMapReadableEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  /** The machine name, or the environment label of a server that is not linked. */
  name: TrimmedNonEmptyString,
});
export type MachineMapReadableEnvironment = typeof MachineMapReadableEnvironment.Type;

/**
 * MM-411 on kitshn: "All environments" settings become the shared part of `t3.settings`.
 * `server` names server settings keys; the server reads their saved values.
 */
export const MachineMapShareSettingsInput = Schema.Struct({
  server: Schema.Array(Schema.String),
  client: SettingValues,
});
export type MachineMapShareSettingsInput = typeof MachineMapShareSettingsInput.Type;

/** False when this server is not a kitshn provider: the change stays a bulk edit. */
export const MachineMapShareSettingsResult = Schema.Struct({ shared: Schema.Boolean });
export type MachineMapShareSettingsResult = typeof MachineMapShareSettingsResult.Type;

export class MachineMapRequestError extends Schema.TaggedError<MachineMapRequestError>()(
  "MachineMapRequestError",
  {
    reason: Schema.Literals([
      "portal-unreachable",
      "join-refused",
      "desktop-only",
      "storage-failed",
      "settings-failed",
    ]),
    /** A message safe to show, such as the refusal of the portal. Never a secret. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Machine map (${this.reason}): ${this.detail}`;
  }
}

/**
 * MM-1908: the longest `machine_exec` run. Cloudflare ends a proxied answer after 100 seconds,
 * and the call waits for the whole run. Revisit when long runs need a job with its own status.
 */
const MACHINE_EXEC_MAX_TIMEOUT_SECONDS = 90;
/** MM-1908: the most bytes of stdout and of stderr that `machine_exec` returns. */
export const MACHINE_EXEC_MAX_OUTPUT_BYTES = 50_000;

export const MachineExecInput = Schema.Struct({
  machine: TrimmedNonEmptyString.annotate({
    description: "Id or name of the other machine, as machines_read lists it. Names ignore case.",
  }),
  command: TrimmedNonEmptyString.annotate({
    description:
      "Shell command. macOS and Linux run it with `$SHELL -c` (or `/bin/sh -c`). Windows runs it with Windows PowerShell. It runs as the user of the T3 server on that machine, with its environment.",
  }),
  cwd: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description:
        "Working directory: an absolute path, or a path that starts with ~. Omit for the home directory of that user. A project path from t3_project_list on that machine works.",
    }),
  ),
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MACHINE_EXEC_MAX_TIMEOUT_SECONDS }),
    ).annotate({
      description: `Seconds before the command and its child processes stop. Default 30, at most ${MACHINE_EXEC_MAX_TIMEOUT_SECONDS}.`,
    }),
  ),
  caller: Schema.optionalKey(
    Schema.Struct({
      threadId: Schema.NullOr(Schema.String),
      threadTitle: Schema.NullOr(Schema.String),
    }).annotate({
      description: "Leave out. The calling machine sets it for the History of the portal.",
    }),
  ),
});
export type MachineExecInput = typeof MachineExecInput.Type;

export const MachineExecResult = Schema.Struct({
  /** The name of the machine that ran the command. */
  machine: TrimmedNonEmptyString,
  cwd: Schema.String,
  shell: Schema.String,
  /** `timedOut`: the timeout stopped the command, and its output is lost. */
  outcome: Schema.Literals(["exited", "timedOut"]),
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  /** The stream had more than `MACHINE_EXEC_MAX_OUTPUT_BYTES`; its text ends with a marker. */
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  durationMs: NonNegativeInt,
});
export type MachineExecResult = typeof MachineExecResult.Type;

/**
 * MM-1919: the WebSocket route of `t3 machine exec`. The CLI opens it on its own server with the
 * MCP credential of its thread; that server opens it on the target with the session of its arrow
 * link. Binary frames carry the data: one channel byte (`MachineExecStreamChannel`), then bytes.
 * Text frames carry `MachineExecStreamMessage` as JSON.
 */
export const MACHINE_EXEC_STREAM_PATH = "/mcp/machine-exec";

export const MachineExecStreamChannel = { stdin: 0, stdout: 1, stderr: 2 } as const;
export type MachineExecStreamChannel =
  (typeof MachineExecStreamChannel)[keyof typeof MachineExecStreamChannel];

export const MachineExecStreamMessage = Schema.Union([
  /** The first frame from the caller. The stream has no time limit unless it sets one. */
  Schema.Struct({
    type: Schema.Literal("start"),
    ...MachineExecInput.fields,
    timeoutSeconds: Schema.optionalKey(PositiveInt),
  }),
  /** From the caller: its stdin ended. */
  Schema.Struct({ type: Schema.Literal("eof") }),
  /** From both ends, so that idle streams stay open through Cloudflare. */
  Schema.Struct({ type: Schema.Literal("ping") }),
  /** The last frame from the target, after all output. */
  Schema.Struct({
    type: Schema.Literal("exit"),
    outcome: Schema.Literals(["exited", "timedOut", "stopped"]),
    exitCode: Schema.NullOr(Schema.Int),
    message: Schema.optionalKey(Schema.String),
  }),
  /** A refusal or failure before the command ran. The last frame. */
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
export type MachineExecStreamMessage = typeof MachineExecStreamMessage.Type;
export type MachineExecStreamStart = Extract<MachineExecStreamMessage, { readonly type: "start" }>;
