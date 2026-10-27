/**
 * Fork: the terminal thread part of a terminal session of `terminal/Manager.ts`. The manager keeps
 * these fields in one `fork` object on each session and calls the functions here at its spawn,
 * output, process poll and summary points, so its own code stays close to upstream.
 */
import type { TerminalSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { isTerminalThreadMainTerminal } from "./shellIntegration.ts";
import { makeShellMarkParser } from "./shellMarks.ts";
import {
  applyShellItems,
  forgetUnconfirmedShellState,
  type ShellState,
} from "./terminalShellState.ts";

export interface ForkTerminalSession extends ShellState {
  shellMarks: ReturnType<typeof makeShellMarkParser> | null;
  /** The `shell` that opened the session, null for the default shell. */
  shellName: string | null;
  /**
   * The running process is a custom shell. Its child process is often the program itself
   * (`uv run python` starts python), so a child does not mean that a program runs.
   */
  customShell: boolean;
}

/** The upstream fields of a terminal session that the fork reads or sets. */
interface ForkSessionHost {
  readonly terminalId: string;
  readonly runtimeEnv: Record<string, string> | null;
  readonly history: { append: (text: string) => void; value: () => string };
  hasRunningSubprocess: boolean;
  childCommandLabel: string | null;
  readonly fork: ForkTerminalSession;
}

export const makeForkTerminalSession = (shellName: string | null): ForkTerminalSession => ({
  attention: null,
  shell: null,
  shellConfirmedAt: 0,
  shellMarks: null,
  command: null,
  commandStartedAt: 0,
  commandEndedAt: null,
  shellName,
  customShell: false,
});

export const forkSummaryFields = (
  fork: ForkTerminalSession,
): Pick<TerminalSummary, "attention" | "shell" | "command" | "commandEndedAt"> => ({
  ...(fork.attention === null ? {} : { attention: fork.attention }),
  ...(fork.shell === null ? {} : { shell: fork.shell }),
  ...(fork.command === null ? {} : { command: fork.command }),
  ...(fork.commandEndedAt === null ? {} : { commandEndedAt: fork.commandEndedAt }),
});

/**
 * Reads the marks of a terminal thread screen. The marks also carry the bell, which a shell
 * without the hook still rings, so every thread screen gets a parser.
 */
export function resetForkShellMarks(session: ForkSessionHost): void {
  session.fork.shellMarks = isTerminalThreadMainTerminal(session.terminalId, session.runtimeEnv)
    ? makeShellMarkParser()
    : null;
}

/** Clears the state of the last shell before a new one starts. */
export function resetForkSessionForStart(session: ForkSessionHost): void {
  session.fork.attention = null;
  session.fork.shell = null;
  session.fork.command = null;
  session.fork.commandEndedAt = null;
  resetForkShellMarks(session);
}

/**
 * The dim line between the output of a terminal thread and the shell that starts below it. It
 * goes into the history, because a client that attaches again redraws from the history.
 */
const NEW_SHELL_MARKER = "\r\n\x1b[2m─ new shell ─\x1b[0m\r\n";

/** Runs in the state update of a shell that started. A failed start calls nothing here. */
export function forkShellSpawned(
  session: ForkSessionHost,
  spawned: {
    readonly custom: boolean;
    readonly integrated: boolean;
    readonly integrationNotice: string | null;
    readonly atMs: number;
  },
): void {
  session.fork.customShell = spawned.custom;
  if (
    isTerminalThreadMainTerminal(session.terminalId, session.runtimeEnv) &&
    session.history.value().length > 0
  ) {
    session.history.append(NEW_SHELL_MARKER);
  }
  if (spawned.integrationNotice !== null) session.history.append(spawned.integrationNotice);
  // A shell with integration reports its state from its first prompt on.
  if (spawned.integrated) {
    session.fork.shell = "starting";
    session.fork.shellConfirmedAt = spawned.atMs;
  }
}

/** Applies the marks of one chunk of output. Returns true when a reported field changed. */
export function applyForkShellOutput(session: ForkSessionHost, data: string): boolean {
  if (session.fork.shellMarks === null) return false;
  return applyShellItems(
    session,
    session.fork.shellMarks.push(data),
    DateTime.formatIso(DateTime.nowUnsafe()),
  );
}

/**
 * Applies one process poll to `hasRunningSubprocess` and `childCommandLabel`. The marks of an
 * integrated shell say whether a program runs, and the poll only names it. A state that no child
 * process confirms is forgotten. Returns true when a reported field changed.
 */
export function applyForkProcessPoll(
  session: ForkSessionHost,
  poll: { readonly hasChildProcess: boolean; readonly childLabel: string | null },
  nowMs: number,
): boolean {
  const before = [
    session.fork.shell,
    session.hasRunningSubprocess,
    session.childCommandLabel,
  ] as const;
  forgetUnconfirmedShellState(session, poll.hasChildProcess, nowMs);
  if (session.fork.shell === null) {
    session.hasRunningSubprocess = poll.hasChildProcess && !session.fork.customShell;
    session.childCommandLabel = session.hasRunningSubprocess ? poll.childLabel : null;
  } else if (session.hasRunningSubprocess && poll.childLabel !== null) {
    session.childCommandLabel = poll.childLabel;
  }
  return (
    before[0] !== session.fork.shell ||
    before[1] !== session.hasRunningSubprocess ||
    before[2] !== session.childCommandLabel
  );
}

/**
 * The open attach streams of each session key. A stream outlives a close and a new open of its
 * terminal, so the count belongs to the key and not to the session. A WebSocket attach holds its
 * count for the whole life of the stream, also while it resubscribes after an overflow.
 */
export function makeAttachCounts() {
  const counts = new Map<string, number>();
  const retain = (key: string): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }),
      () =>
        Effect.sync(() => {
          const remaining = (counts.get(key) ?? 1) - 1;
          if (remaining > 0) counts.set(key, remaining);
          else counts.delete(key);
        }),
    );
  return { retain, has: (key: string) => counts.has(key) };
}
