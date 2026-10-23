/**
 * Fork: machine map agent tools (`apps/machine-map/SPEC.md`, MM-801). The `machines_*` tools run
 * through the portal connection of this machine, and the portal checks the map role of this
 * machine on every call (MM-802, MM-805). `machine_exec` goes to the other machine directly. Other
 * T3 tools reach another machine with `environmentId`, through the arrow links (MM-303).
 */
import {
  MACHINE_EXEC_MAX_OUTPUT_BYTES,
  MachineExecInput,
  MachineExecResult,
  MachineMapClientState,
  MachineMapJoinInput,
  MapToolInputs,
  type MapToolName,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as MachineExec from "../../../fork/machineMap/MachineExec.ts";
import * as MachineMap from "../../../fork/machineMap/MachineMap.ts";
import * as MachinePeers from "../../../fork/machineMap/MachinePeers.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    MachineMap.MachineMap,
    MachinePeers.MachinePeers,
    MachineExec.MachineExec,
  ],
};

/** Appended to every tool that runs through the portal. */
const PORTAL_NOTE =
  "The call goes through the portal connection of this machine, and the portal checks the map role of this machine (machines_read shows it). It fails when this machine has no portal connection, when the portal does not answer within 30 seconds, and while the owner's emergency pause is on. Only the owner can end the pause, in the portal.";

/** Appended to every map change. */
const MAP_WRITE_NOTE =
  'With the map role `edit`, a change that raises no access applies at once and the result is {"_tag":"applied","revision":n}. Only the owner raises access: a change that raises a level, turns on agent tools or exec, or raises a map role, for any machine, waits in the portal Inbox, and so does every change with the role `propose`. Then the result is {"_tag":"proposed","proposalId":"...","reason":"map-role"|"self-escalation"|"owner-only"}. The owner approves or rejects a proposal; it expires after 24 hours. Each applied change is a revision that machines_undo can reverse. An offline machine applies the change when it connects.';

const mapTool = <const Name extends Exclude<MapToolName, "machines_read" | "machines_resources">>(
  name: Name,
  description: string,
) =>
  Tool.make(name, {
    ...shared,
    description: `${description} Needs a live full-access/default calling thread or a full-access client; the map role never raises a caller's limits. ${PORTAL_NOTE}`,
    parameters: MapToolInputs[name],
    success: Schema.Unknown,
  });

// MCP needs an object root for parameters, so the tool without inputs declares none.
const MachinesReadTool = Tool.make("machines_read", {
  ...shared,
  description: `Read the machine map. Call it first to find machine ids, map roles, revision numbers and command ids. Needs the map role \`read\`. Changes nothing. The result is {"_tag":"read", map, presence, commands, history, proposals, resources, capabilities, execs, calls}: map holds the machines, arrows, shared settings with the overrides of each machine, and presets, and the owner's display data: notes (sticky notes with text and a place) and pairPlacements (where the owner put pair cards), which no machine applies; presence.<machineId> holds online, lastSeenAt and status (build, running turns, supported commands, clients); resources holds latest.<machineId> (the newest resource sample), thresholds.<machineId> (health thresholds) and alerts (the active health alerts); capabilities lists for each arrow with any what agents on \`from\` can do on \`to\` (readThreads, launch, exec, settings); execs and calls list the newest machine_exec runs and T3 tool calls forwarded to other machines, without their output; history holds the newest 50 revisions and makes most of the size, often more than 50,000 characters. ${PORTAL_NOTE}`,
  success: Schema.Unknown,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const MachinesResourcesTool = Tool.make("machines_resources", {
  ...shared,
  description: `Read the resource history of the machine with id machineId (from machines_read): CPU, memory, disk, swap and agent processes. Range \`hour\` and \`day\` give one point a minute, \`month\` one point an hour; the default is \`hour\`. The result is {"_tag":"resources", history, alerts}: alerts holds the health alerts of that machine that were active in the range. Needs the map role \`read\`. Changes nothing. ${PORTAL_NOTE}`,
  parameters: MapToolInputs.machines_resources,
  success: Schema.Unknown,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const MachinesSetAccessTool = mapTool(
  "machines_set_access",
  `Set the arrow from machine \`from\` to machine \`to\`: its access level, whether agents on \`from\` can call tools on \`to\`, and an optional expiry. \`from\` and \`to\` are machine ids from machines_read. Use it to remove or lower access between two machines, or to propose more access to the owner. A lower level ends the sessions of \`from\` on \`to\` at once. The owner keeps full access to every machine whatever the arrows say. Needs the map role \`propose\` or \`edit\`. ${MAP_WRITE_NOTE}`,
).annotate(Tool.Destructive, true);

const MachinesSetSettingTool = mapTool(
  "machines_set_setting",
  `Set or clear a setting: the shared value of every machine, or the override of one machine when machineId (a machine id from machines_read) is set. \`key\` is a top-level settings key, for example recoverInterruptedTurns. Every key works except the machine-local ones (machineMap, paths, secrets, project-keyed maps), which fail. A key without a shared value changes nothing on any machine until a shared value is set. Each machine applies the value live through its settings service. Needs the map role \`propose\` or \`edit\`. ${MAP_WRITE_NOTE}`,
).annotate(Tool.Destructive, true);

const MachinesCommandTool = mapTool(
  "machines_command",
  'Send a one-time command to the machine with id machineId (from machines_read), for example {"_tag":"stopAllAgents"} or {"_tag":"collectDiagnostics"}. Use only a command that the machine lists in presence.<machineId>.status.commands. Needs the map role `edit`; a command never becomes a proposal and cannot be undone. restartServer and stopAllAgents stop the running agent turns on that machine, the turn of the caller too when it runs there. An offline machine gets the command when it connects; delivery `idle` also waits until no agent runs there. A queued command expires after 24 hours unless expiresInMinutes says otherwise; cancel it with machines_queue_cancel. The result is {"_tag":"command", command} with status `queued`. Read the outcome later in `commands` of machines_read.',
).annotate(Tool.Destructive, true);

const MachinesQueueCancelTool = mapTool(
  "machines_queue_cancel",
  'Cancel a command that its machine did not take yet (status `queued`). commandId comes from `commands` in machines_read. A delivered or finished command cannot be cancelled. Needs the map role `edit`. The result is {"_tag":"command", command} with status `cancelled`.',
).annotate(Tool.Destructive, true);

const MachinesUndoTool = mapTool(
  "machines_undo",
  `Undo one revision of the map. The undo is a new revision, so the history keeps both and the undo can be undone too. Commands are not revisions and cannot be undone. Needs the map role \`propose\` or \`edit\`. ${MAP_WRITE_NOTE}`,
).annotate(Tool.Destructive, true);

const MachinesPresetTool = mapTool(
  "machines_preset",
  `Save the current arrows as a named preset, or apply a saved preset. To cut all access and stop running agents, the owner uses the emergency pause in the portal; agents cannot press it. Needs the map role \`propose\` or \`edit\`. ${MAP_WRITE_NOTE}`,
).annotate(Tool.Destructive, true);

const MachinesJoinTool = Tool.make("machines_join", {
  ...shared,
  description:
    "Join this machine to the machine map with a one-time join code from Add machine in the portal. Agents cannot join (MM-919). On a headless machine, the owner runs t3 machine-map join <code>; on desktop, use Settings > Machines. A joined machine with the map on refuses another join. To leave, the owner uses Settings > Machines > Leave.",
  parameters: MachineMapJoinInput,
  success: MachineMapClientState,
}).annotate(Tool.Destructive, true);

const MachineExecTool = Tool.make("machine_exec", {
  ...shared,
  description: `Run a shell command on another machine of the map, through the T3 server of that machine, as its user. Use it for work that needs that machine: logs, builds, git, services. It needs an arrow from this machine to that machine with exec and agent tools on and the level standard or admin, and a live full-access/default caller with orchestration, worktree and pull-requests tool capabilities. Restricted callers are refused. The other machine checks the arrow again, and an emergency pause, a removed arrow or exec turned off stops a running command at once. It does not need the portal. The portal History records the machine, the calling thread, the command, the exit code and the time, never the output. The call waits for the command, at most the timeout. Start long work with nohup or a service and poll it instead. With a shell, \`t3 machine exec <machine> -- <command>\` runs the same command with stdin, streamed and binary output, its exit code and no time limit. The result is {machine, cwd, shell, outcome ("exited" or "timedOut"), exitCode, stdout, stderr, stdoutTruncated, stderrTruncated, durationMs}. stdout and stderr keep at most ${MACHINE_EXEC_MAX_OUTPUT_BYTES} bytes each and then end with a truncation marker. A timeout loses the output.`,
  parameters: MachineExecInput,
  success: MachineExecResult,
}).annotate(Tool.Destructive, true);

export const MachineMapToolkit = Toolkit.make(
  MachinesReadTool,
  MachinesResourcesTool,
  MachinesSetAccessTool,
  MachinesSetSettingTool,
  MachinesCommandTool,
  MachinesQueueCancelTool,
  MachinesUndoTool,
  MachinesPresetTool,
  MachinesJoinTool,
  MachineExecTool,
);
