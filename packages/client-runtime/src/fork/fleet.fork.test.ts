import { MachineId, type ScheduledTask } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { fleetDaemonText, fleetMenuEntries, fleetTaskSummary } from "./fleet.ts";

const task = (
  title: string,
  fields: Pick<ScheduledTask, "enabled" | "lastRunStatus" | "lastRunAt">,
): ScheduledTask => ({ title, ...fields }) as ScheduledTask;

it("counts enabled tasks and names the most recent failed run", () => {
  const summary = fleetTaskSummary([
    task("Backup", { enabled: true, lastRunStatus: "failed", lastRunAt: "2026-10-30T08:00:00Z" }),
    task("Sync", { enabled: false, lastRunStatus: "failed", lastRunAt: "2026-10-31T08:00:00Z" }),
    task("Digest", {
      enabled: true,
      lastRunStatus: "succeeded",
      lastRunAt: "2026-11-01T08:00:00Z",
    }),
  ]);
  expect(summary.enabled).toBe(2);
  expect(summary.lastFailed?.title).toBe("Sync");
  expect(fleetTaskSummary([]).lastFailed).toBeNull();
});

it("offers only the commands that the server of the row runs", () => {
  // A server without the background service or a supervisor, such as `npx t3`.
  const entries = fleetMenuEntries(["stopAllAgents", "pauseScheduledTasks", "startThread"]);
  expect(entries.map((entry) => entry.command._tag)).toEqual([
    "stopAllAgents",
    "pauseScheduledTasks",
  ]);
  expect(entries[0]?.separatorBefore).toBe(false);
  expect(fleetMenuEntries(["restartServer", "installUpdate"]).map((entry) => entry.label)).toEqual([
    "Install update when idle",
    "Install update now",
    "Restart server",
  ]);
  expect(fleetMenuEntries(undefined)).toEqual([]);
});

it("names the kitshn daemon only for a kitshn-joined row", () => {
  const machine = { id: MachineId.make("mac-bbec10"), name: "Mac" };
  expect(fleetDaemonText(machine, { version: "5156a69eb82c", protocol: "2.0.0" })).toBe(
    "daemon 5156a69eb82c · protocol 2.0.0",
  );
  expect(fleetDaemonText(machine, null)).toBe("daemon unknown");
  expect(fleetDaemonText(machine, undefined)).toBeNull();
  expect(fleetDaemonText(undefined, null)).toBeNull();
});
