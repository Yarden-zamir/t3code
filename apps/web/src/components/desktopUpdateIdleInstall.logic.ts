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
 * Counts the threads, subagents included, whose agent turn runs on the
 * environment that a desktop update restarts.
 */
export function countRunningAgentTurns(
  threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId"> & {
      readonly source: Pick<EnvironmentThreadShell["source"], "status">;
    }
  >,
  environmentId: EnvironmentId | null,
): number {
  if (environmentId === null) return 0;
  return threads.filter(
    (thread) =>
      thread.environmentId === environmentId && RUNNING_AGENT_STATUSES.has(thread.source.status),
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
