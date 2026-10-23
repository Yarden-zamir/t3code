import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_TERMINAL_ID, isTerminalThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  createTerminalThreadStatesAtom,
  terminalThreadEnvironmentsKey,
  terminalThreadState,
  type TerminalThreadState,
  type TerminalThreadStates,
} from "@t3tools/client-runtime/state/fork-terminal-threads";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
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
  const summary = sessions?.find((session) => session.target.terminalId === DEFAULT_TERMINAL_ID)
    ?.state.summary;
  return summary ? terminalThreadState(summary) : undefined;
}

const terminalThreadStatesAtom = createTerminalThreadStatesAtom({
  metadata: terminalEnvironment.metadata,
  sessionState: environmentSession.sessionStateAtom,
});

/** Fork: the main terminal states of the terminal threads among `threads`, for list rules. */
export function useTerminalThreadStates(
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "providerInstanceId">>,
): TerminalThreadStates {
  return useAtomValue(terminalThreadStatesAtom(terminalThreadEnvironmentsKey(threads)));
}

/** Fork: the main terminal state of a terminal thread at click time, or undefined for any other. */
export function readTerminalThreadState(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "providerInstanceId">,
): TerminalThreadState | undefined {
  if (!isTerminalThread(thread)) return undefined;
  const metadata = appAtomRegistry.get(
    terminalEnvironment.metadata({ environmentId: thread.environmentId, input: null }),
  );
  const summaries = Option.getOrElse(AsyncResult.value(metadata), () => []);
  const main = summaries.find(
    (summary) => summary.threadId === thread.id && summary.terminalId === DEFAULT_TERMINAL_ID,
  );
  return main ? terminalThreadState(main) : undefined;
}

/**
 * Fork: what the thread menus read at click time for a thread. A program that runs in the main
 * terminal blocks archive like an agent run, because archive ends it; a terminal thread has no
 * messages to regenerate a title from.
 */
export function readForkThreadMenuState(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "providerInstanceId">,
): {
  readonly terminal: TerminalThreadState | undefined;
  readonly programRuns: boolean;
  readonly titleRegeneration: boolean;
} {
  const terminal = readTerminalThreadState(thread);
  return {
    terminal,
    programRuns: terminal?.running === true,
    titleRegeneration: !isTerminalThread(thread),
  };
}
