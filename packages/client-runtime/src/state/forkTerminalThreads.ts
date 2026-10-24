/**
 * Fork: the live state of a terminal thread for the thread lists of web and mobile. A terminal
 * thread keeps its state in the metadata of its main terminal, not in the thread shell. The thread
 * shell atoms (`threadShell.ts`) put it on each terminal thread as `terminal`, and the upstream
 * list rules (Working shelf, inbox order, snooze wake) read it through these wrappers.
 */
import {
  AuthTerminalReadScope,
  DEFAULT_TERMINAL_ID,
  sessionGrantsScope,
  type AuthSessionState,
  type EnvironmentId,
  type TerminalAttention,
  type TerminalSessionStatus,
  type TerminalSummary,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentThreadShell } from "./models.ts";
import { isThreadWorking } from "./threadInbox.ts";
import { effectiveSnoozed, threadWokeAt, type ThreadSnoozeShell } from "./threadSettled.ts";

/** What the thread lists know of the main terminal of a terminal thread. */
export interface TerminalThreadState {
  readonly status: TerminalSessionStatus;
  readonly attention: TerminalAttention | null;
  /** A program runs in the foreground of the shell. A background job does not count. */
  readonly running: boolean;
  /** When the shell failed to start (server time), so a visit after it clears Failed. */
  readonly failedAt: string | null;
}

export function terminalThreadState(summary: TerminalSummary): TerminalThreadState {
  return {
    status: summary.status,
    attention: summary.attention ?? null,
    running: summary.hasRunningSubprocess,
    // A failed session changes no more, so its last update is the time of the failure.
    failedAt: summary.status === "error" ? summary.updatedAt : null,
  };
}

/** The main terminal states of the terminal threads of one environment, by thread id. */
export type TerminalThreadStates = ReadonlyMap<ThreadId, TerminalThreadState>;

const EMPTY_TERMINAL_THREAD_STATES: TerminalThreadStates = new Map();

const sameAttention = (left: TerminalAttention | null, right: TerminalAttention | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.kind === right.kind &&
    left.at === right.at &&
    left.exitCode === right.exitCode &&
    left.bellAt === right.bellAt);

const sameTerminalThreadState = (left: TerminalThreadState, right: TerminalThreadState) =>
  left.status === right.status &&
  left.running === right.running &&
  left.failedAt === right.failedAt &&
  sameAttention(left.attention, right.attention);

/**
 * The states of the main terminals in `summaries`. A state that did not change keeps its object,
 * and an unchanged set keeps `previous`, so a terminal event re-renders only the rows it changes.
 */
export function selectTerminalThreadStates(
  summaries: ReadonlyArray<TerminalSummary>,
  previous: TerminalThreadStates,
): TerminalThreadStates {
  const next = new Map<ThreadId, TerminalThreadState>();
  for (const summary of summaries) {
    if (summary.terminalId !== DEFAULT_TERMINAL_ID) continue;
    const threadId = summary.threadId as ThreadId;
    const state = terminalThreadState(summary);
    const kept = previous.get(threadId);
    next.set(threadId, kept !== undefined && sameTerminalThreadState(kept, state) ? kept : state);
  }
  if (next.size === 0) return EMPTY_TERMINAL_THREAD_STATES;
  return next.size === previous.size &&
    [...next].every(([threadId, state]) => previous.get(threadId) === state)
    ? previous
    : next;
}

/** Why Archive refuses a terminal thread: archive ends the program that runs in it. */
export const TERMINAL_PROGRAM_ARCHIVE_BLOCK_MESSAGE =
  "A program runs in its terminal, and archive would end it. Stop the program first.";

/**
 * Delete stays allowed while a program runs, unlike Archive: it is an explicit destructive action.
 * Its confirm says that the program ends.
 */
export const TERMINAL_PROGRAM_DELETE_NOTICE = "A program runs in its terminal. Delete ends it.";
export const TERMINAL_PROGRAMS_DELETE_NOTICE =
  "Programs run in some of these terminals. Delete ends them.";

/** The line that the Remove project confirm adds when programs run in its terminal threads. */
export function projectRemovalProgramNotice(
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "terminal">>,
): ReadonlyArray<string> {
  const running = threads.filter((thread) => thread.terminal?.running === true).length;
  if (running === 0) return [];
  return [
    running === 1
      ? "A program runs in one of its terminal threads. Remove ends it."
      : `Programs run in ${running} of its terminal threads. Remove ends them.`,
  ];
}

/**
 * The terminal thread states of one environment. An environment without terminal read access
 * reports none. The thread shell atoms read it only for an environment with terminal threads, so
 * other environments never subscribe to terminal metadata.
 */
export function createTerminalThreadStatesAtom(input: {
  readonly metadata: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: null;
  }) => Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<TerminalSummary>, unknown>>;
  readonly sessionState: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<AuthSessionState, unknown>>;
}) {
  return Atom.family((environmentId: EnvironmentId) => {
    let previous = EMPTY_TERMINAL_THREAD_STATES;
    return Atom.make((get): TerminalThreadStates => {
      const session = get(input.sessionState(environmentId));
      const sessionValue = Option.getOrNull(AsyncResult.value(session));
      const canRead =
        session._tag !== "Failure" &&
        sessionValue !== null &&
        sessionGrantsScope(sessionValue, AuthTerminalReadScope);
      const summaries = canRead
        ? Option.getOrElse(
            AsyncResult.value(get(input.metadata({ environmentId, input: null }))),
            () => [],
          )
        : [];
      previous = selectTerminalThreadStates(summaries, previous);
      return previous;
    }).pipe(Atom.withLabel(`fork-terminal-thread-states:${environmentId}`));
  });
}

export type TerminalThreadStatusLabel =
  | "Connecting"
  | "Error"
  | "Awaiting Input"
  | "Working"
  | "Completed";

// A thread that nobody opened yet has no visit, so everything it reports is unseen: a schedule
// or an agent can start a terminal thread that the user never looked at.
function isUnseen(at: string, seenAt: string | null | undefined) {
  if (!seenAt) return true;
  const atMs = Date.parse(at);
  const seen = Date.parse(seenAt);
  return !Number.isNaN(atMs) && (Number.isNaN(seen) || atMs > seen);
}

const attentionIsUnseen = (attention: TerminalAttention, seenAt: string | null | undefined) =>
  isUnseen(attention.at, seenAt);

/** A later program end keeps the time of the bell before it in `bellAt`. */
function bellIsUnseen(attention: TerminalAttention | null, seenAt: string | null | undefined) {
  const bellAt = attention?.kind === "bell" ? attention.at : attention?.bellAt;
  return bellAt !== undefined && isUnseen(bellAt, seenAt);
}

/**
 * The status pill that a terminal thread adds to the pill of its message runs, the same pills as
 * an agent thread. A bell or an app notification asks for input, also while a program runs or
 * after it ended, because the program wants the user. A program that runs is working. A program
 * that ended is completed work, or an error when it exited with a non-zero code. Input, completed
 * and error show until the user visits the thread after them.
 */
export function terminalThreadStatusLabel(
  terminal: TerminalThreadState | undefined,
  lastVisitedAt: string | null | undefined,
): TerminalThreadStatusLabel | null {
  if (!terminal) return null;
  if (terminal.status === "error") {
    return terminal.failedAt !== null && isUnseen(terminal.failedAt, lastVisitedAt)
      ? "Error"
      : null;
  }
  if (terminal.status === "starting") return "Connecting";
  const { attention } = terminal;
  if (bellIsUnseen(attention, lastVisitedAt)) return "Awaiting Input";
  if (terminal.running) return "Working";
  if (attention === null || !attentionIsUnseen(attention, lastVisitedAt)) return null;
  return (attention.exitCode ?? 0) === 0 ? "Completed" : "Error";
}

type RowStatus = "approval" | "input" | "working" | "waiting" | "failed" | "limited" | "ready";

/**
 * The status of a terminal thread row in a thread list. A bell shows Input, also over a message
 * run that works, because a message that runs a program can ring it. Otherwise message runs keep
 * their own status, so the terminal only fills in an idle row: a failed session or a program that
 * exited with a non-zero code shows Failed, and a starting session or a running program shows
 * Working. `Completed` is the unread dot.
 */
export function terminalThreadRowStatus<Status extends RowStatus>(
  status: Status,
  label: TerminalThreadStatusLabel | null,
): Status | "input" | "failed" | "working" {
  if (label === "Awaiting Input" && status === "working") return "input";
  if (status !== "ready" && status !== "waiting") return status;
  if (label === "Awaiting Input") return "input";
  if (label === "Error") return "failed";
  if (label === "Connecting" || label === "Working") return "working";
  return status;
}

/**
 * `isThreadWorking` for the Working shelf. A terminal thread also works while its row shows
 * Working: a program runs in the shell, even a dev server that runs for days.
 */
export function forkThreadIsWorking(
  thread: Parameters<typeof isThreadWorking>[0] &
    Pick<EnvironmentThreadShell, "lastVisitedAt" | "terminal">,
): boolean {
  if (isThreadWorking(thread)) return true;
  const label = terminalThreadStatusLabel(thread.terminal, thread.lastVisitedAt);
  return label === "Working" || label === "Connecting";
}

/**
 * The inbox return time with the terminal: a terminal thread returns to the top of the inbox
 * when its program ends or it rings a bell, like an agent thread whose run finishes.
 */
export function forkInboxReturnAt<T>(
  returnedAt: ((thread: T) => number | undefined) | undefined,
): (thread: T & Pick<EnvironmentThreadShell, "terminal">) => number | undefined {
  return (thread) => {
    const attentionAt = Date.parse(thread.terminal?.attention?.at ?? "");
    const observed = returnedAt?.(thread);
    if (Number.isNaN(attentionAt)) return observed;
    return Math.max(observed ?? 0, attentionAt);
  };
}

/**
 * When a snoozed terminal thread raised its hand: a bell, or a program that ended, after the
 * snooze, like an agent run that finishes while snoozed. Attention from before the snooze does
 * not wake it, and the thread stays awake after a visit.
 */
function terminalRaisedHandAt(
  terminal: TerminalThreadState | undefined,
  snoozedAt: string | null | undefined,
): string | null {
  const attention = terminal?.attention;
  if (!attention) return null;
  return attentionIsUnseen(attention, snoozedAt) ? attention.at : null;
}

/** `effectiveSnoozed` where a bell or an ended program of a terminal thread also wakes it. */
export function forkEffectiveSnoozed(
  shell: ThreadSnoozeShell & Pick<EnvironmentThreadShell, "terminal">,
  options: { readonly now: string },
): boolean {
  return (
    effectiveSnoozed(shell, options) &&
    terminalRaisedHandAt(shell.terminal, shell.snoozedAt) === null
  );
}

/** `threadWokeAt` where a bell or an ended program of a terminal thread also wakes it. */
export function forkThreadWokeAt(
  shell: ThreadSnoozeShell & Pick<EnvironmentThreadShell, "terminal">,
  options: { readonly now: string },
): string | null {
  const wokeAt = threadWokeAt(shell, options);
  if (shell.snoozedUntil == null || Number.isNaN(Date.parse(shell.snoozedUntil))) return wokeAt;
  return terminalRaisedHandAt(shell.terminal, shell.snoozedAt) ?? wokeAt;
}
