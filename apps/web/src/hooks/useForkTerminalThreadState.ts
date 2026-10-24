import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_TERMINAL_ID, isTerminalThread } from "@t3tools/contracts";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  createTerminalThreadStatesAtom,
  TERMINAL_PROGRAM_DELETE_NOTICE,
  TERMINAL_PROGRAMS_DELETE_NOTICE,
  terminalThreadEnvironmentsKey,
  terminalThreadState,
  type TerminalThreadState,
  type TerminalThreadStates,
} from "@t3tools/client-runtime/state/fork-terminal-threads";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import type { ThreadArchiveBlock } from "../components/threadActionMenu.logic";
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

/** Fork: `useTerminalThreadStates` at click time, for actions outside render. */
export function readTerminalThreadStates(
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "providerInstanceId">>,
): TerminalThreadStates {
  return appAtomRegistry.get(terminalThreadStatesAtom(terminalThreadEnvironmentsKey(threads)));
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
 * Fork: what the thread menus and Archive read at click time for a thread. A program that runs in
 * the main terminal blocks archive like an agent run, because archive ends it. A terminal thread
 * has no messages to regenerate a title from. It has no Mark unread either: the server marks a
 * thread unread before its last message run, and a terminal thread shows its program ends and
 * bells without runs. Revisit if a user needs to mark a seen program end unread.
 */
export function readForkThreadMenuState(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "providerInstanceId" | "runtime">,
): {
  readonly terminal: TerminalThreadState | undefined;
  readonly archiveBlock: ThreadArchiveBlock | null;
  readonly titleRegeneration: boolean;
  readonly markUnread: boolean;
} {
  const terminal = readTerminalThreadState(thread);
  return {
    terminal,
    archiveBlock: !threadRuntimeCanArchive(thread.runtime)
      ? "agent"
      : terminal?.running === true
        ? "program"
        : null,
    titleRegeneration: !isTerminalThread(thread),
    markUnread: !isTerminalThread(thread),
  };
}

/** Fork: the line that the Delete confirm adds when a program runs in one of `threads`. */
export function readForkDeleteNotice(
  threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "providerInstanceId">
  >,
): ReadonlyArray<string> {
  const programRuns = threads.some((thread) => readTerminalThreadState(thread)?.running === true);
  if (!programRuns) return [];
  return [threads.length === 1 ? TERMINAL_PROGRAM_DELETE_NOTICE : TERMINAL_PROGRAMS_DELETE_NOTICE];
}
