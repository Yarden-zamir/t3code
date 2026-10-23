import { useAtomValue } from "@effect/atom-react";
import {
  createTerminalThreadStatesAtom,
  terminalThreadEnvironmentsKey,
  type TerminalThreadStates,
} from "@t3tools/client-runtime/state/fork-terminal-threads";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { appAtomRegistry } from "./atom-registry";
import { environmentSession } from "./session";
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
