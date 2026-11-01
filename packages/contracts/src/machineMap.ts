/**
 * Fork: shared types of the T3 machines on kitshn: levels, settings sync, machine commands and
 * device machine lists. MM-xxx numbers name the older machine map rules that kitshn's SPEC cites.
 */
import * as Schema from "effect/Schema";

import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  type AuthGrantScope,
  type AuthMcpClientAccess,
  AuthOrchestrationReadScope,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
  AuthTerminalReadScope,
} from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** An ISO 8601 time, for example `2026-10-13T08:00:00.000Z`. */
export const MapTime = TrimmedNonEmptyString;
export type MapTime = typeof MapTime.Type;

export const MachineId = TrimmedNonEmptyString.pipe(Schema.brand("MachineId"));
export type MachineId = typeof MachineId.Type;

/** What one machine can do on another (MM-302). */
export const MachineLevel = Schema.Literals(["none", "read", "standard", "admin"]);
export type MachineLevel = typeof MachineLevel.Type;

export const MACHINE_LEVEL_SCOPES: Readonly<Record<MachineLevel, ReadonlyArray<AuthGrantScope>>> = {
  none: [],
  read: [
    AuthOrchestrationReadScope,
    AuthFilesystemReadScope,
    AuthTerminalReadScope,
    AuthDiagnosticsReadScope,
  ],
  // Upstream pairing grants access and relay management by default. The fork keeps them for `admin`.
  standard: AuthStandardClientScopes.filter(
    (scope) =>
      scope !== AuthAccessReadScope &&
      scope !== AuthAccessWriteScope &&
      scope !== AuthRelayWriteScope,
  ),
  admin: AuthStandardClientScopes,
};

/**
 * MM-302: the linked-environment access of each level above `none`. `standard` work is fenced to
 * the threads its link started (upstream `linkOrigin.ts`); only `admin` is not fenced.
 */
export const MACHINE_LEVEL_LINK_ACCESS = {
  read: "read-only",
  standard: "auto",
  admin: "full-access",
} as const satisfies Record<Exclude<MachineLevel, "none">, AuthMcpClientAccess>;

/** The session subject of a machine on the server of another machine (MM-1305). */
export const machineSessionSubject = (machineId: MachineId): string => `machine:${machineId}`;

/** The session subject of a client on a machine (MM-911). */

/**
 * MM-1921: upstream links always expire, so a permanent arrow link reports this expiry. Clients
 * show no expiry for it. Revisit when upstream `PeerLink.expiresAt` may be null.
 */
export const ARROW_LINK_NO_EXPIRY = "9999-12-31T00:00:00.000Z";

/** A browser profile that the owner approved (MM-904). */
export const ClientId = TrimmedNonEmptyString.pipe(Schema.brand("ClientId"));
export type ClientId = typeof ClientId.Type;

/**
 * MM-906: the short code of a browser key, for example `K7qP-3m_x`. The waiting browser and the
 * portal both show it, so the owner can tell that they approve the right sign-in. It keeps 8
 * base64url characters with their case, about 48 bits, so a look-alike key is not practical.
 */

export const SettingScope = Schema.Literals(["server", "client"]);
export type SettingScope = typeof SettingScope.Type;

/** Setting values by key. The T3 settings schemas validate them where they apply. */
export const SettingValues = Schema.Record(Schema.String, Schema.Unknown);
export type SettingValues = typeof SettingValues.Type;

export const ScopedSettingValues = Schema.Struct({
  server: SettingValues,
  client: SettingValues,
});
export type ScopedSettingValues = typeof ScopedSettingValues.Type;

/**
 * Fork: the server setting that holds the rules of `keybindings.json` while `keybindingSync` is
 * on. It is no settings service field: the machine map reads and writes the file.
 */
export const KEYBINDINGS_SETTING_KEY = "keybindings";

/**
 * MM-406: settings that belong to one machine. They never become map entries: a machine does not
 * report them, the portal refuses a value for them, and a machine never applies one.
 */
const MACHINE_LOCAL_SETTINGS: Readonly<Record<SettingScope, ReadonlySet<string>>> = {
  server: new Set([
    // The connection to the portal itself: a shared value could cut it.
    "machineMap",
    // Secrets: a machine reports them redacted, so a shared value would erase them.
    "providerInstances",
    "sourceControlHosts",
    "usageLimitSources",
    // Paths on the file system of this machine.
    "worktreesDirectory",
    "previousWorktreesDirectories",
    "addProjectBaseDirectory",
    "worktreePathTemplate",
    // Keyed by project id. A project id is local to one environment.
    "projectSettingsOverrides",
    "projectScriptOverrides",
    "pinnedProjectScriptIds",
    // Keyed by thread id. A thread id is local to one environment.
    "pinnedMessages",
    "projectAutoPullOverrides",
    "projectAgentBrowserAccessOverrides",
    // SSH hosts and the device setup of this machine.
    "deviceHosts",
    "deviceOnboardingCompleted",
    // Uses the keychain of this machine.
    "cursorKeychainUsageEnabled",
    // The icon that tells this machine apart from the others.
    "environmentIcon",
    // The time of the last local theme change (MM-408).
    "defaultThemeSetAt",
    // A one-time migration flag of this machine's own settings file, not a preference.
    "projectSettingsFolded",
  ]),
  client: new Set([
    // State of this app, not a preference.
    "onboardingCompletedAt",
    "dismissedProviderUpdateNotificationKeys",
    // Browser profiles point to data folders on this machine.
    "browserProfiles",
    "browserDefaultProfileId",
  ]),
};

export const isMachineLocalSetting = (scope: SettingScope, key: string): boolean =>
  MACHINE_LOCAL_SETTINGS[scope].has(key);

export const withoutMachineLocalSettings = (
  scope: SettingScope,
  values: Readonly<Record<string, unknown>>,
): SettingValues =>
  Object.fromEntries(Object.entries(values).filter(([key]) => !isMachineLocalSetting(scope, key)));

/** Who made a change or sent a command (MM-702). */
export const MapActor = Schema.Union([
  Schema.TaggedStruct("owner", { email: TrimmedNonEmptyString, device: Schema.String }),
  Schema.TaggedStruct("agent", {
    machineId: MachineId,
    threadId: Schema.NullOr(Schema.String),
    threadTitle: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("portal", { reason: TrimmedNonEmptyString }),
]);
export type MapActor = typeof MapActor.Type;

/** MM-501. `rotateToken` is not here: the portal sends it as its own message. */
export const MachineCommandInput = Schema.Union([
  Schema.TaggedStruct("restartServer", {}).annotate({
    description: "Restart the T3 server. Its supervisor starts it again. Running agent turns stop.",
  }),
  Schema.TaggedStruct("installUpdate", {
    whenIdle: Schema.Boolean.annotate({
      description: "True waits until no agent runs on the machine. False installs now.",
    }),
  }).annotate({
    description:
      "Install an update. A desktop app installs what its update button offers, while the app runs. A server that runs as the T3 Code background service installs the newest fork release (MM-505).",
  }),
  Schema.TaggedStruct("stopAllAgents", {}).annotate({
    description: "Interrupt every running agent turn on the machine.",
  }),
  Schema.TaggedStruct("pauseScheduledTasks", {}).annotate({
    description: "Pause every scheduled task on the machine.",
  }),
  Schema.TaggedStruct("resumeScheduledTasks", {}).annotate({
    description: "Resume the scheduled tasks of the machine.",
  }),
  Schema.TaggedStruct("setScheduledTaskEnabled", {
    taskId: TrimmedNonEmptyString.annotate({
      description: "Task id from presence.<machineId>.status.tasks in machines_read.",
    }),
    enabled: Schema.Boolean.annotate({ description: "False pauses the task. True resumes it." }),
  }).annotate({
    description:
      "Pause or resume one scheduled task on the machine. taskId comes from presence.<machineId>.status.tasks in machines_read.",
  }),
  Schema.TaggedStruct("runScheduledTask", {
    taskId: TrimmedNonEmptyString.annotate({
      description: "Task id from presence.<machineId>.status.tasks in machines_read.",
    }),
  }).annotate({
    description: "Run one scheduled task on the machine now, like its Run now button.",
  }),
  Schema.TaggedStruct("reloadWindows", {}).annotate({
    description: "Reload the desktop app windows. Desktop machines only.",
  }),
  Schema.TaggedStruct("startThread", {
    projectId: TrimmedNonEmptyString.annotate({
      description: "Project id on the target machine. Read it there with t3_project_list.",
    }),
    title: TrimmedNonEmptyString.annotate({ description: "Title of the new thread." }),
    message: TrimmedNonEmptyString.annotate({ description: "First message to the agent." }),
  }).annotate({
    description:
      "Start a thread on the machine, like t3_thread_launch there. projectId is a project id on that machine (t3_project_list there); title and message are text.",
  }),
  Schema.TaggedStruct("revokeClient", {
    sessionId: TrimmedNonEmptyString.annotate({
      description: "Client session id from presence.<machineId>.status.clients in machines_read.",
    }),
  }).annotate({
    description:
      "End one client session on the machine. sessionId comes from presence.<machineId>.status.clients in machines_read.",
  }),
  Schema.TaggedStruct("collectDiagnostics", {}).annotate({
    description:
      "Collect versions, recent errors, processes and resource use. The bundle is the command result.",
  }),
  Schema.TaggedStruct("testArrow", {
    to: MachineId.annotate({ description: "Target machine id of the arrow to test." }),
  }).annotate({
    description:
      "Connect from the machine to the machine id `to` and report reachability, round trip time and scopes.",
  }),
]);
export type MachineCommandInput = typeof MachineCommandInput.Type;
export type MachineCommandKind = MachineCommandInput["_tag"];

export const MachineCommandKindSchema = Schema.Literals([
  "restartServer",
  "installUpdate",
  "stopAllAgents",
  "pauseScheduledTasks",
  "resumeScheduledTasks",
  "setScheduledTaskEnabled",
  "runScheduledTask",
  "reloadWindows",
  "startThread",
  "revokeClient",
  "collectDiagnostics",
  "testArrow",
]);

/** MM-605. */
export const CommandDelivery = Schema.Literals(["online", "idle"]);
export type CommandDelivery = typeof CommandDelivery.Type;

export const CommandStatus = Schema.Literals([
  "queued",
  "delivered",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
]);
export type CommandStatus = typeof CommandStatus.Type;

export const MachineCommand = Schema.Struct({
  id: TrimmedNonEmptyString,
  machineId: MachineId,
  input: MachineCommandInput,
  delivery: CommandDelivery,
  actor: MapActor,
  status: CommandStatus,
  createdAt: MapTime,
  updatedAt: MapTime,
  expiresAt: MapTime,
  /** Command output for the portal, for example the diagnostics bundle or a test result. */
  result: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.String),
});
export type MachineCommand = typeof MachineCommand.Type;

export const MachineClientSession = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  subject: Schema.String,
  deviceType: Schema.NullOr(Schema.String),
  os: Schema.NullOr(Schema.String),
  browser: Schema.NullOr(Schema.String),
  connected: Schema.Boolean,
  lastSeenAt: Schema.NullOr(MapTime),
});
export type MachineClientSession = typeof MachineClientSession.Type;

/** MM-1601: one scheduled task as the portal shows it. */
export const MachineScheduledTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.String,
  enabled: Schema.Boolean,
  /** The schedule in words, for example "Every 1 hour" or "Weekdays at 09:00". */
  schedule: Schema.String,
  nextRunAt: Schema.NullOr(MapTime),
  lastRunAt: Schema.NullOr(MapTime),
  lastRunStatus: Schema.NullOr(Schema.String),
  lastRunError: Schema.NullOr(Schema.String),
});
export type MachineScheduledTask = typeof MachineScheduledTask.Type;

/** MM-1002. */
export const MachineStatus = Schema.Struct({
  t3Version: Schema.String,
  /** `<kind> <commit>`: `live`, `deploy` or `dev` with a 7-character commit, or `release`. */
  build: Schema.String,
  hostname: Schema.NullOr(TrimmedNonEmptyString),
  uptimeSeconds: Schema.Number,
  runningTurns: NonNegativeInt,
  waitingThreads: NonNegativeInt,
  scheduledTasks: NonNegativeInt,
  /** The version of a waiting update, or null. */
  updateWaiting: Schema.NullOr(Schema.String),
  cpuPercent: Schema.NullOr(Schema.Number),
  memoryPercent: Schema.NullOr(Schema.Number),
  commands: Schema.Array(MachineCommandKindSchema),
  clients: Schema.Array(MachineClientSession),
  /** MM-1601: absent on machines that do not report their tasks yet. */
  tasks: Schema.optionalKey(Schema.Array(MachineScheduledTask)),
});
export type MachineStatus = typeof MachineStatus.Type;

/** MM-914: a machine that a client can reach, with the origin of its T3 server. */
export const ClientMachine = Schema.Struct({
  id: MachineId,
  name: TrimmedNonEmptyString,
  origin: TrimmedNonEmptyString,
});
export type ClientMachine = typeof ClientMachine.Type;

/** MM-914: `GET <portal>/client/machines` with the token headers of a native app. */
export const ClientMachinesResponse = Schema.Struct({ machines: Schema.Array(ClientMachine) });
export type ClientMachinesResponse = typeof ClientMachinesResponse.Type;

/** K-1601: one provider card that a device token opens, with its machine and its T3 origin. */
export const DeviceMachine = Schema.Struct({
  ...ClientMachine.fields,
  card: Schema.String,
  kind: Schema.String,
  level: Schema.String,
});
export type DeviceMachine = typeof DeviceMachine.Type;

/** K-1601, K-1617: `GET https://kit.<zone>/device/machines` with the device's service token. */
export const DeviceMachinesResponse = Schema.Struct({ machines: Schema.Array(DeviceMachine) });
export type DeviceMachinesResponse = typeof DeviceMachinesResponse.Type;

/** The device machine list of the zone of `origin` (`https://t3-<machine>.<zone>`), or null. */
export const deviceMachinesUrl = (origin: string): string | null => {
  const host = URL.parse(origin)?.hostname ?? "";
  const dot = host.indexOf(".");
  return dot <= 0 ? null : `https://kit.${host.slice(dot + 1)}/device/machines`;
};

/** The T3 servers of a device machine list: only `t3.app` cards. */
export const t3AppMachines = (response: {
  readonly machines: ReadonlyArray<DeviceMachine>;
}): ClientMachinesResponse => ({
  machines: response.machines
    .filter((machine) => machine.kind === "t3.app")
    .map(({ id, name, origin }) => ({ id, name, origin })),
});

/**
 * K-1601: kitshn's answer to `POST /join/device`. The secret is in this answer only. The app
 * keeps it and sends both values as `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
 */
export const ClientEnrollResponse = Schema.Struct({
  clientId: ClientId,
  name: TrimmedNonEmptyString,
  serviceToken: Schema.Struct({
    clientId: TrimmedNonEmptyString,
    clientSecret: TrimmedNonEmptyString,
  }),
  machines: Schema.Array(DeviceMachine),
  /** The absolute URL of `GET /device/machines`. */
  machinesUrl: TrimmedNonEmptyString,
});
export type ClientEnrollResponse = typeof ClientEnrollResponse.Type;
