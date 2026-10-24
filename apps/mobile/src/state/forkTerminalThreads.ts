import { useAtomValue } from "@effect/atom-react";
import {
  createTerminalThreadStatesAtom,
  terminalThreadEnvironmentsKey,
  type TerminalThreadStates,
} from "@t3tools/client-runtime/state/fork-terminal-threads";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
} from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentServerConfig } from "./entities";
import { environmentSession, useEnvironmentScope } from "./session";
import { terminalEnvironment } from "./terminal";

const terminalThreadStatesAtom = createTerminalThreadStatesAtom({
  metadata: terminalEnvironment.metadata,
  sessionState: environmentSession.sessionStateAtom,
});

type ThreadEnvironment = Pick<EnvironmentThreadShell, "environmentId" | "providerInstanceId">;

/** Fork: the main terminal states of the terminal threads among `threads`. */
export function useTerminalThreadStates(
  threads: ReadonlyArray<ThreadEnvironment>,
): TerminalThreadStates {
  return useAtomValue(terminalThreadStatesAtom(terminalThreadEnvironmentsKey(threads)));
}

/** Fork: `useTerminalThreadStates` at call time, for actions outside render. */
export function readTerminalThreadStates(
  threads: ReadonlyArray<ThreadEnvironment>,
): TerminalThreadStates {
  return appAtomRegistry.get(terminalThreadStatesAtom(terminalThreadEnvironmentsKey(threads)));
}

/**
 * Fork: this phone can start a terminal thread in the environment: the server setting
 * `terminalThreads` is on, and the grants allow a new thread and a terminal.
 */
export function useTerminalThreadsAvailable(environmentId: EnvironmentId | null): boolean {
  const enabled = useEnvironmentServerConfig(environmentId)?.settings.terminalThreads === true;
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canCreateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  return enabled && canOperateTerminal && canCreateThread;
}
