/** Fork: the scheduled task summary of one Fleet row, for web and mobile. */
import type { ScheduledTask } from "@t3tools/contracts";

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
