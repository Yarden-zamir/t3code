/**
 * Fork: the machine tools. kitshn is the only path: the `machines_*` tools ask the kitshn daemon of
 * this machine (K-1710 to K-1712), and kitshn checks the circles of this machine on each ask. The
 * tool names stay from the machine map. `machine_exec` is a kitshn exec (K-722).
 */
import {
  MACHINE_EXEC_MAX_OUTPUT_BYTES,
  MachineExecInput,
  MachineExecResult,
  OrchestratorMcpFailure,
  SettingScope,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as KitshnCli from "../../../fork/kitshn/KitshnCli.ts";
import * as KitshnConnection from "../../../fork/kitshn/KitshnConnection.ts";
import * as KitshnGrants from "../../../fork/kitshn/KitshnGrants.ts";
import * as KitshnProvider from "../../../fork/kitshn/KitshnProvider.ts";
import * as KitshnSettingsSync from "../../../fork/kitshn/KitshnSettingsSync.ts";
import * as MachineExec from "../../../fork/machineMap/MachineExec.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    KitshnProvider.KitshnProvider,
    KitshnSettingsSync.KitshnSettingsSync,
    KitshnGrants.KitshnGrants,
    KitshnConnection.KitshnConnection,
    KitshnCli.KitshnCli,
    MachineExec.MachineExec,
  ],
};

/** Appended to every tool that asks kitshn. */
const KITSHN_NOTE =
  "The call goes to the kitshn daemon of this machine. It fails when this machine has no kitshn 2, is not joined to kitshn, or its daemon does not run. Access between machines, history, undo and presets are on the kitshn map, not in these tools.";

const MachinesReadTool = Tool.make("machines_read", {
  ...shared,
  description: `Read what kitshn shows this machine. Changes nothing. The result is {"_tag":"read", machine, connection, state, stateError, askResults, jobResults, execResults}: machine is {id, name} of this machine on the kitshn map, or null before it registered. connection is {status ("off", "connecting" or "registered"), detail (why it is off or why the last connection ended), linkProxy (boolean), syncedAt (epoch ms of kitshn's last answer), paused (kitshn's emergency pause), problems ([{path, reason}] that kitshn dropped)}. state is null with stateError when kitshn cannot answer; otherwise it is the answer of the kitshn state ask: rights (what kitshn lets this machine do), circles ({id, name, level} that this machine can see), cards (the cards that this machine manages, with kind, name, addresses, status, circles, deploy, backup and uptime), proposals (open asks that this machine may answer) and repos. Newest first: askResults are answers to this machine's waiting asks {proposalId, outcome ("approved", "denied" or "expired"), result, reason}; jobResults are ends of its jobs {jobId, state, exitCode, output}; execResults are machine_exec runs that waited for the owner {proposalId, result}, result being the machine_exec result or {machine, refused}. It does not list other machines or their status. ${KITSHN_NOTE}`,
  success: Schema.Unknown,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const MachinesResourcesTool = Tool.make("machines_resources", {
  ...shared,
  description: `Read the resource samples of this machine from its kitshn daemon: CPU, memory and disk as shares from 0 to 1. Only this machine. Changes nothing. The result is {"_tag":"resources", newest, history}: newest is {at, cpu, memory, disk} taken now, and history holds the samples of the last hour, oldest first; nothing older. ${KITSHN_NOTE}`,
  success: Schema.Unknown,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const MachinesSetSettingInput = Schema.Struct({
  part: Schema.Literals(["machine", "shared"]).annotate({
    description:
      "machine: this machine's own value, which applies over the shared one. shared: the value of every machine on kitshn; only the owner sets it, so an agent thread is refused.",
  }),
  scope: SettingScope.annotate({
    description: "server: T3 server settings (settings.json). client: settings of all client apps.",
  }),
  key: TrimmedNonEmptyString.annotate({
    description:
      "Top-level settings key, for example recoverInterruptedTurns. Any key works except the machine-local ones, such as paths and secrets.",
  }),
  value: Schema.optionalKey(
    Schema.Unknown.annotate({
      description: "New value, in the type of the settings schema. Omit with clear.",
    }),
  ),
  clear: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "True removes the value from that part, also when `value` is set.",
    }),
  ),
});

const MachinesSetSettingTool = Tool.make("machines_set_setting", {
  ...shared,
  description: `Set or clear one setting in the T3 settings state on kitshn (K-709): this machine's own part, or the shared part of every machine. Each machine applies the shared part, then its own part over it. It cannot change the part of another machine. The result is {"_tag":"setting", part, scope, key}. ${KITSHN_NOTE}`,
  parameters: MachinesSetSettingInput,
  success: Schema.Unknown,
}).annotate(Tool.Destructive, true);

export const MachinesCommandInput = Schema.Struct({
  machineId: TrimmedNonEmptyString.annotate({
    description: "Id of the machine on the kitshn map that runs the command.",
  }),
  command: TrimmedNonEmptyString.annotate({
    description:
      "The command id of the T3 card: restart-server, install-update, stop-all-agents, pause-scheduled-tasks or collect-diagnostics. With row: run-task, pause-task or resume-task for a row of the tasks list, revoke-session for a row of the sessions list. The machine runs only the commands that its T3 card lists.",
  }),
  resource: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description: 'The card id of the command. Default "app", the T3 card.',
    }),
  ),
  row: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description:
        'The row id of a card list that the command is for, for example "task:<taskId>" or "session:<sessionId>". The T3 card of each machine on the kitshn map lists its scheduled tasks and client sessions. Omit it for a command of the whole card.',
    }),
  ),
});

const MachinesCommandTool = Tool.make("machines_command", {
  ...shared,
  description: `Run a command of the T3 card on a machine as a kitshn job (K-1612). kitshn runs it at once only when a circle that holds this machine may run commands there. Otherwise the job waits for the owner. The result is {"_tag":"command", outcome} with outcome "done" and result (it holds the job id), or "waiting" and proposalId, whose answer shows later in askResults of machines_read; a refusal fails with its reason. restart-server and stop-all-agents stop the running agent turns there, the caller's too when it runs there. Cancel a queued job with machines_queue_cancel. ${KITSHN_NOTE}`,
  parameters: MachinesCommandInput,
  success: Schema.Unknown,
}).annotate(Tool.Destructive, true);

export const MachinesQueueCancelInput = Schema.Struct({
  jobId: Schema.Int.annotate({
    description: "Id of a queued kitshn job that this machine queued, from machines_command.",
  }),
});

const MachinesQueueCancelTool = Tool.make("machines_queue_cancel", {
  ...shared,
  description: `Cancel a kitshn job that this machine queued, while it waits in the queue. A job that started, or one that another machine queued, cannot be cancelled. The result is {"_tag":"cancelled", jobId}. ${KITSHN_NOTE}`,
  parameters: MachinesQueueCancelInput,
  success: Schema.Unknown,
}).annotate(Tool.Destructive, true);

export const MachinesJoinInput = Schema.Struct({
  code: TrimmedNonEmptyString.annotate({
    description: "One-time join code from Add machine on the kitshn map.",
  }),
  server: TrimmedNonEmptyString.annotate({
    description: "The kitshn address, for example https://kit.example.com.",
  }),
});

const MachinesJoinTool = Tool.make("machines_join", {
  ...shared,
  description:
    'Join this machine to kitshn with a one-time join code: it runs `kitshn join` of the machine\'s kitshn 2. Agents cannot join. On a machine, the owner runs `kitshn join <code> --server <address>` in a shell. The result is {"_tag":"joined", output}.',
  parameters: MachinesJoinInput,
  success: Schema.Unknown,
}).annotate(Tool.Destructive, true);

const MachineExecTool = Tool.make("machine_exec", {
  ...shared,
  description: `Run a shell command on another machine through kitshn, as the user of its T3 provider; T3 there is not needed, so it can repair T3. Use it for work that needs that machine: logs, builds, git, services. It needs a link to that machine's T3 app card, kitshn's "runs commands" right there, and a live full-access/default caller with orchestration, worktree and pull-requests tool capabilities. If the owner must approve, the call waits 60 seconds, then returns outcome "waiting": tell the user that it waits for the owner's approval on kitshn and do not send it again; its result shows later in execResults of machines_read. A denial fails with its reason. The call waits for the command, at most the timeout. Background jobs end with it, also with nohup. In a shell, \`t3 machine exec <machine> -- <command>\` adds stdin, streamed output and the exit code, for up to an hour. The result is {machine, outcome ("exited" or "timedOut"), exitCode, signal, stdout, stderr, stdoutTruncated, stderrTruncated, durationMs} or {machine, outcome "waiting", proposalId, message}. stdout and stderr keep ${MACHINE_EXEC_MAX_OUTPUT_BYTES} bytes each, then a truncation marker.`,
  parameters: MachineExecInput,
  success: MachineExecResult,
}).annotate(Tool.Destructive, true);

export const MachineMapToolkit = Toolkit.make(
  MachinesReadTool,
  MachinesResourcesTool,
  MachinesSetSettingTool,
  MachinesCommandTool,
  MachinesQueueCancelTool,
  MachinesJoinTool,
  MachineExecTool,
);
