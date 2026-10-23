import { DEFAULT_TERMINAL_ID, isTerminalThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import type { TerminalThreadState } from "../lib/forkTerminalThreadStatus";
import { useKnownTerminalSessions } from "../state/terminalSessions";

/** Fork: the main terminal state of a terminal thread, or undefined for any other thread. */
export function useTerminalThreadState(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "providerInstanceId">,
): TerminalThreadState | undefined {
  const isTerminal = isTerminalThread(thread);
  const sessions = useKnownTerminalSessions({
    environmentId: isTerminal ? thread.environmentId : null,
    threadId: isTerminal ? thread.id : null,
  });
  const main = sessions?.find((session) => session.target.terminalId === DEFAULT_TERMINAL_ID);
  return main
    ? {
        status: main.state.status,
        attention: main.state.summary?.attention ?? null,
        running: main.state.summary?.hasRunningSubprocess === true,
      }
    : undefined;
}
