import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationV2ShellThreadStatus } from "@t3tools/contracts";

// "waiting" is left out: the agent turn is over and only the checkpoint drains.
const RUNNING_AGENT_STATUSES: ReadonlySet<OrchestrationV2ShellThreadStatus> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
]);

/**
 * Counts the threads, subagents included, whose agent turn or background command runs on the
 * environment that a desktop update restarts. The same rule as the server update in
 * `apps/server/src/fork/ForkUpdates.ts`: the restart kills a background command.
 */
export function countRunningAgentTurns(
  threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "pendingBackgroundTasks"> & {
      readonly source: Pick<EnvironmentThreadShell["source"], "status">;
    }
  >,
  environmentId: EnvironmentId | null,
): number {
  if (environmentId === null) return 0;
  return threads.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      (RUNNING_AGENT_STATUSES.has(thread.source.status) ||
        thread.pendingBackgroundTasks.some((task) => task.kind === "command")),
  ).length;
}

/**
 * Counts the terminal threads whose program a desktop update ends: the restart of the server
 * closes their shells.
 */
export function countRunningTerminalPrograms(
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "terminal">>,
  environmentId: EnvironmentId | null,
): number {
  if (environmentId === null) return 0;
  return threads.filter(
    (thread) => thread.environmentId === environmentId && thread.terminal?.running === true,
  ).length;
}

const counted = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** The title of the "Install when idle" prompt, such as "2 agents and 1 terminal program running". */
export function idleInstallWorkTitle(agents: number, terminalPrograms: number): string {
  const parts = [
    ...(agents > 0 ? [counted(agents, "agent")] : []),
    ...(terminalPrograms > 0 ? [counted(terminalPrograms, "terminal program")] : []),
  ];
  return parts.length === 0 ? "Nothing running" : `${parts.join(" and ")} running`;
}

/** A wait for idle. "automatic" comes from `forkUpdateMode`, "user" from "Install when idle". */
export interface IdleInstallArm {
  readonly at: number;
  readonly by: "user" | "automatic";
}

/**
 * The arm after `forkUpdateMode` or the downloaded update changes. Automatic mode arms for a
 * download. Manual mode cancels an automatic arm, and keeps a wait that the user chose.
 */
export function nextAutomaticArm(
  current: IdleInstallArm | null,
  automatic: boolean,
  downloaded: boolean,
  now: number,
): IdleInstallArm | null {
  if (automatic) return downloaded && current === null ? { at: now, by: "automatic" } : current;
  return current?.by === "automatic" ? null : current;
}
