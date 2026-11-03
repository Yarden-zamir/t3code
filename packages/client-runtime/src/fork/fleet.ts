/** Fork: the scheduled task summary and the command menu of one Fleet row, for web and mobile. */
import type {
  FleetCommandInput,
  ForkUpdateMode,
  KitshnDaemon,
  KitshnMachineRef,
  MachineCommandKind,
  ScheduledTask,
} from "@t3tools/contracts";

export const FLEET_UPDATE_MODE_TEXT: Record<ForkUpdateMode, string> = {
  automatic: "Automatic updates",
  manual: "Manual updates",
};

export interface FleetTaskSummary {
  readonly enabled: number;
  /** The task whose last run failed most recently, or null. */
  readonly lastFailed: ScheduledTask | null;
}

export function fleetTaskSummary(tasks: ReadonlyArray<ScheduledTask>): FleetTaskSummary {
  let lastFailed: ScheduledTask | null = null;
  for (const task of tasks) {
    if (task.lastRunStatus !== "failed" || task.lastRunAt === null) continue;
    if (lastFailed === null || task.lastRunAt > (lastFailed.lastRunAt ?? "")) lastFailed = task;
  }
  return { enabled: tasks.filter((task) => task.enabled).length, lastFailed };
}

export interface FleetMenuEntry {
  readonly label: string;
  readonly command: FleetCommandInput;
  readonly separatorBefore: boolean;
}

const FLEET_MENU: ReadonlyArray<FleetMenuEntry> = [
  {
    label: "Install update when idle",
    command: { _tag: "installUpdate", whenIdle: true },
    separatorBefore: false,
  },
  {
    label: "Install update now",
    command: { _tag: "installUpdate", whenIdle: false },
    separatorBefore: false,
  },
  { label: "Restart server", command: { _tag: "restartServer" }, separatorBefore: true },
  { label: "Stop all agents", command: { _tag: "stopAllAgents" }, separatorBefore: false },
  {
    label: "Pause scheduled tasks",
    command: { _tag: "pauseScheduledTasks" },
    separatorBefore: false,
  },
  {
    label: "Resume scheduled tasks",
    command: { _tag: "resumeScheduledTasks" },
    separatorBefore: false,
  },
];

/**
 * The menu entries that the server of the row runs, from `machineCommands` of its config. A
 * separator shows only after an entry. No config yet means no entries.
 */
export function fleetMenuEntries(
  machineCommands: ReadonlyArray<MachineCommandKind> | undefined,
): ReadonlyArray<FleetMenuEntry> {
  const supported = new Set(machineCommands ?? []);
  return FLEET_MENU.filter((entry) => supported.has(entry.command._tag)).map((entry, index) =>
    index === 0 ? { ...entry, separatorBefore: false } : entry,
  );
}

/**
 * The daemon part of a Fleet row: null for a manual environment and while the read is pending.
 * `daemon` is null when the server does not know it, for example while kitshn shows it offline.
 */
export function fleetDaemonText(
  kitshnMachine: KitshnMachineRef | undefined,
  daemon: KitshnDaemon | null | undefined,
): string | null {
  if (kitshnMachine === undefined || daemon === undefined) return null;
  return daemon === null
    ? "daemon unknown"
    : `daemon ${daemon.version} · protocol ${daemon.protocol}`;
}
