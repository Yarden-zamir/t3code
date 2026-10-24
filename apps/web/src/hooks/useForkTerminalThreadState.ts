import { isTerminalThread } from "@t3tools/contracts";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  TERMINAL_PROGRAM_DELETE_NOTICE,
  TERMINAL_PROGRAMS_DELETE_NOTICE,
} from "@t3tools/client-runtime/state/fork-terminal-threads";

import type { ThreadArchiveBlock } from "../components/threadActionMenu.logic";

/**
 * Fork: what the thread menus and Archive read at click time for a thread. A program that runs in
 * the main terminal blocks archive like an agent run, because archive ends it. A terminal thread
 * has no messages to regenerate a title from. It has no Mark unread either: the server marks a
 * thread unread before its last message run, and a terminal thread shows its program ends and
 * bells without runs. Revisit if a user needs to mark a seen program end unread.
 */
export function readForkThreadMenuState(
  thread: Pick<EnvironmentThreadShell, "providerInstanceId" | "runtime" | "terminal">,
): {
  readonly archiveBlock: ThreadArchiveBlock | null;
  readonly titleRegeneration: boolean;
  readonly markUnread: boolean;
} {
  return {
    archiveBlock: !threadRuntimeCanArchive(thread.runtime)
      ? "agent"
      : thread.terminal?.running === true
        ? "program"
        : null,
    titleRegeneration: !isTerminalThread(thread),
    markUnread: !isTerminalThread(thread),
  };
}

/** Fork: the line that the Delete confirm adds when a program runs in one of `threads`. */
export function readForkDeleteNotice(
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "terminal">>,
): ReadonlyArray<string> {
  const programRuns = threads.some((thread) => thread.terminal?.running === true);
  if (!programRuns) return [];
  return [threads.length === 1 ? TERMINAL_PROGRAM_DELETE_NOTICE : TERMINAL_PROGRAMS_DELETE_NOTICE];
}
