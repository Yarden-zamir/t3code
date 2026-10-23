/**
 * Fork: the live state of a terminal thread for the thread lists of web and mobile. A terminal
 * thread keeps its state in the metadata of its main terminal, not in the thread shell, so the
 * upstream list rules (Working shelf, inbox order, snooze wake) take it through these wrappers.
 */
import {
  AuthTerminalReadScope,
  DEFAULT_TERMINAL_ID,
  isTerminalThread,
  sessionGrantsScope,
  type AuthSessionState,
  type EnvironmentId,
  type TerminalAttention,
  type TerminalSessionStatus,
  type TerminalSummary,
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
}

export function terminalThreadState(summary: TerminalSummary): TerminalThreadState {
  return {
    status: summary.status,
    attention: summary.attention ?? null,
    running: summary.hasRunningSubprocess,
  };
}

/** The main terminals of terminal threads, keyed by `terminalThreadKey`. */
export type TerminalThreadStates = ReadonlyMap<string, TerminalThreadState>;

type ThreadRef = Pick<EnvironmentThreadShell, "environmentId" | "id">;

const terminalThreadKey = (thread: { readonly environmentId: string; readonly id: string }) =>
  `${thread.environmentId}:${thread.id}`;

export function selectTerminalThreadStates(
  metadataByEnvironment: ReadonlyArray<
    readonly [EnvironmentId, ReadonlyArray<TerminalSummary> | null]
  >,
): TerminalThreadStates {
  const states = new Map<string, TerminalThreadState>();
  for (const [environmentId, summaries] of metadataByEnvironment) {
    for (const summary of summaries ?? []) {
      if (summary.terminalId !== DEFAULT_TERMINAL_ID) continue;
      states.set(
        terminalThreadKey({ environmentId, id: summary.threadId }),
        terminalThreadState(summary),
      );
    }
  }
  return states;
}

/** Why Archive refuses a terminal thread: archive ends the program that runs in it. */
export const TERMINAL_PROGRAM_ARCHIVE_BLOCK_MESSAGE =
  "A program runs in its terminal, and archive would end it. Stop the program first.";

/**
 * Agent threads have a `term-1` drawer terminal too, so only a terminal thread reads its state.
 */
export function terminalStateOf(
  states: TerminalThreadStates | undefined,
  thread: ThreadRef & Pick<EnvironmentThreadShell, "providerInstanceId">,
): TerminalThreadState | undefined {
  return isTerminalThread(thread) ? states?.get(terminalThreadKey(thread)) : undefined;
}

/**
 * The terminal thread states of a list of environments, keyed by their ids joined with "\n".
 * An environment without terminal read access reports none.
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
  return Atom.family((environmentIdsKey: string) =>
    Atom.make((get): TerminalThreadStates => {
      const environmentIds =
        environmentIdsKey === "" ? [] : (environmentIdsKey.split("\n") as EnvironmentId[]);
      return selectTerminalThreadStates(
        environmentIds.map((environmentId) => {
          const session = get(input.sessionState(environmentId));
          const sessionValue = Option.getOrNull(AsyncResult.value(session));
          const canRead =
            session._tag !== "Failure" &&
            sessionValue !== null &&
            sessionGrantsScope(sessionValue, AuthTerminalReadScope);
          if (!canRead) return [environmentId, null] as const;
          const metadata = get(input.metadata({ environmentId, input: null }));
          return [environmentId, Option.getOrNull(AsyncResult.value(metadata))] as const;
        }),
      );
    }).pipe(Atom.withLabel(`fork-terminal-thread-states:${environmentIdsKey}`)),
  );
}

/** The atom key of the environments that hold terminal threads. */
export function terminalThreadEnvironmentsKey(
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "providerInstanceId">>,
): string {
  return [...new Set(threads.filter(isTerminalThread).map((thread) => thread.environmentId))]
    .sort()
    .join("\n");
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
  if (terminal.status === "error") return "Error";
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
  thread: Parameters<typeof isThreadWorking>[0] & Pick<EnvironmentThreadShell, "lastVisitedAt">,
  terminal: TerminalThreadState | undefined,
): boolean {
  if (isThreadWorking(thread)) return true;
  const label = terminalThreadStatusLabel(terminal, thread.lastVisitedAt);
  return label === "Working" || label === "Connecting";
}

/**
 * The inbox return time with the terminal: a terminal thread returns to the top of the inbox
 * when its program ends or it rings a bell, like an agent thread whose run finishes.
 */
export function forkInboxReturnAt<
  T extends ThreadRef & Pick<EnvironmentThreadShell, "providerInstanceId">,
>(
  returnedAt: ((thread: T) => number | undefined) | undefined,
  states: TerminalThreadStates | undefined,
): (thread: T) => number | undefined {
  return (thread) => {
    const attentionAt = Date.parse(terminalStateOf(states, thread)?.attention?.at ?? "");
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
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
  terminal: TerminalThreadState | undefined,
): boolean {
  return (
    effectiveSnoozed(shell, options) && terminalRaisedHandAt(terminal, shell.snoozedAt) === null
  );
}

/** `threadWokeAt` where a bell or an ended program of a terminal thread also wakes it. */
export function forkThreadWokeAt(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
  terminal: TerminalThreadState | undefined,
): string | null {
  const wokeAt = threadWokeAt(shell, options);
  if (shell.snoozedUntil == null || Number.isNaN(Date.parse(shell.snoozedUntil))) return wokeAt;
  return terminalRaisedHandAt(terminal, shell.snoozedAt) ?? wokeAt;
}
