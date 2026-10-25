/**
 * Fork: machine map contract between a T3 server and its own clients. The portal protocol is in
 * `machineMap.ts`, and MM-xxx refers to `apps/machine-map/SPEC.md`. `machineMap.subscribe` sends
 * the whole state on each change. The local desktop app also gets `tokenHeaders`, runs
 * `desktopCommands`, and reports back with `machineMap.reportDesktop`.
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  MachineCommand,
  MachineDesiredState,
  MachineLevel,
  MachineMapDocument,
  MachinePresence,
  MapTime,
  PeerMachine,
  SettingValues,
} from "./machineMap.ts";
import { HealthAlert, ResourcesOverview } from "./machineMapResources.ts";

/**
 * - `off`: the `machineMap` setting is off.
 * - `not-joined`: the setting is on, but no machine token is saved. Join with a code.
 * - `connecting`: the server dials the portal, or waits before the next attempt.
 * - `online`: the portal connection is open.
 */
export const MachineMapConnectionStatus = Schema.Literals([
  "off",
  "not-joined",
  "connecting",
  "online",
]);
export type MachineMapConnectionStatus = typeof MachineMapConnectionStatus.Type;

export const MachineMapConnection = Schema.Struct({
  status: MachineMapConnectionStatus,
  /** When the connection entered this status. */
  since: MapTime,
  /** Why the last attempt failed, while `connecting`. Never a secret. */
  lastError: Schema.NullOr(Schema.String),
  /** Failed attempts since the last open connection. */
  failedAttempts: NonNegativeInt,
});
export type MachineMapConnection = typeof MachineMapConnection.Type;

/**
 * The machine token as request headers. Cloudflare Access accepts them on the hostname of every
 * machine that has an arrow from this machine (MM-306).
 */
export const MachineMapTokenHeaders = Schema.Struct({
  "CF-Access-Client-Id": TrimmedNonEmptyString,
  "CF-Access-Client-Secret": TrimmedNonEmptyString,
});
export type MachineMapTokenHeaders = typeof MachineMapTokenHeaders.Type;

/** A peer that this machine can use: its arrow is above `none` and its hostname is known. */
export const MachineMapReachablePeer = Schema.Struct({
  machine: PeerMachine,
  level: MachineLevel,
  agentTools: Schema.Boolean,
  /** `https://<hostname>`, the T3 server of the peer behind its tunnel. */
  origin: TrimmedNonEmptyString,
});
export type MachineMapReachablePeer = typeof MachineMapReachablePeer.Type;

export const MachineMapClientState = Schema.Struct({
  enabled: Schema.Boolean,
  portalUrl: TrimmedNonEmptyString,
  /** A machine token is saved. */
  joined: Schema.Boolean,
  connection: MachineMapConnection,
  /** The last desired state that this machine applied, or null before the first one. */
  desired: Schema.NullOr(MachineDesiredState),
  /** MM-306, MM-1401: the desktop app keeps one saved environment for each of these. */
  reachable: Schema.Array(MachineMapReachablePeer),
  /**
   * Only for the local desktop app (a `desktop-bootstrap` session). Null for every other client,
   * and while no token is saved.
   */
  tokenHeaders: Schema.NullOr(MachineMapTokenHeaders),
  /**
   * MM-1402: commands that only the desktop app can run (`installUpdate`, `reloadWindows`). They
   * wait here until a desktop app reports their result. Empty for every client but the desktop.
   */
  desktopCommands: Schema.Array(MachineCommand),
});
export type MachineMapClientState = typeof MachineMapClientState.Type;

/**
 * MM-1907: an environment whose threads the agents of this server can read: the server itself,
 * then each machine that an arrow with agent tools from it reaches now.
 */
export const MachineMapReadableEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  /** The machine name, or the environment label of a server that is not on the map. */
  name: TrimmedNonEmptyString,
});
export type MachineMapReadableEnvironment = typeof MachineMapReadableEnvironment.Type;

export const MachineMapJoinInput = Schema.Struct({
  code: TrimmedNonEmptyString.annotate({
    description:
      "One-time join code from Add machine in the portal, for example K7QM-2XPA. It works once.",
  }),
  portalUrl: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description:
        "Portal origin, for example https://t3.yarden-zamir.com. Omit to keep the portal of the machineMap setting.",
    }),
  ),
});
export type MachineMapJoinInput = typeof MachineMapJoinInput.Type;

export const MachineMapDesktopCommandResult = Schema.Struct({
  commandId: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  result: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.String),
});
export type MachineMapDesktopCommandResult = typeof MachineMapDesktopCommandResult.Type;

/** What the local desktop app reports. Each omitted field keeps its last reported value. */
export const MachineMapDesktopReport = Schema.Struct({
  commandResult: Schema.optionalKey(MachineMapDesktopCommandResult),
  /** The version of the desktop update that waits to install, or null when none waits. */
  updateWaiting: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The build the desktop app runs (MM-1002). Null for the release. */
  build: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The current client settings of the desktop app (MM-403, MM-404, MM-405). */
  clientSettings: Schema.optionalKey(SettingValues),
});
export type MachineMapDesktopReport = typeof MachineMapDesktopReport.Type;

/**
 * MM-411: a change that T3 Settings saved for all environments. The server sends the saved values
 * of `server` and the given `client` values to the portal as shared values.
 */
export const MachineMapShareSettingsInput = Schema.Struct({
  /** Server settings keys. The server reads their saved values. */
  server: Schema.Array(Schema.String),
  client: SettingValues,
});
export type MachineMapShareSettingsInput = typeof MachineMapShareSettingsInput.Type;

/** False when this machine is not on the map or not connected: the change stays a bulk edit. */
export const MachineMapShareSettingsResult = Schema.Struct({ shared: Schema.Boolean });
export type MachineMapShareSettingsResult = typeof MachineMapShareSettingsResult.Type;

/**
 * MM-1701: an alert as the Machines panel reads it. The kind is an open string, so an alert kind
 * that a newer portal adds does not break the panel of this build.
 */
const PanelHealthAlert = Schema.Struct({ ...HealthAlert.fields, kind: Schema.String });

/** MM-1701: the part of a `machines_read` result that the Machines panel shows. */
export const MachinesReadResult = Schema.TaggedStruct("read", {
  map: MachineMapDocument,
  presence: Schema.Record(Schema.String, MachinePresence),
  commands: Schema.Array(MachineCommand),
  resources: Schema.Struct({ ...ResourcesOverview.fields, alerts: Schema.Array(PanelHealthAlert) }),
});
export type MachinesReadResult = typeof MachinesReadResult.Type;

/**
 * MM-1701: what the Machines panel gets. `unavailable` says why there is no map: `off` (setting
 * off or no machine token), `paused` (emergency pause, MM-711), `not-connected`, `timed-out` and
 * `refused` (the portal call failed), or `unreadable` (a portal result that this server does not
 * understand).
 */
export const MachineMapPanelState = Schema.Union([
  MachinesReadResult,
  Schema.TaggedStruct("unavailable", {
    reason: Schema.Literals([
      "off",
      "paused",
      "not-connected",
      "timed-out",
      "refused",
      "unreadable",
    ]),
    /** A message safe to show. Never a secret. */
    detail: Schema.String,
  }),
]);
export type MachineMapPanelState = typeof MachineMapPanelState.Type;

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
