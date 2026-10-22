import type { TerminalAttention, TerminalSessionStatus } from "@t3tools/contracts";

/** Fork: what the sidebar knows of the main terminal of a terminal thread. */
export interface TerminalThreadState {
  readonly status: TerminalSessionStatus | "closed";
  readonly attention: TerminalAttention | null;
}

export type TerminalThreadStatusLabel = "Connecting" | "Error" | "Awaiting Input" | "Completed";

function attentionIsUnseen(attention: TerminalAttention, lastVisitedAt: string | null | undefined) {
  if (!lastVisitedAt) return false;
  const at = Date.parse(attention.at);
  const visited = Date.parse(lastVisitedAt);
  return !Number.isNaN(at) && (Number.isNaN(visited) || at > visited);
}

/**
 * Fork: the status pill that a terminal thread adds to the pill of its message runs. A bell or an
 * app notification asks for input, a program that ended is completed work, both until the user
 * visits the thread. A program that runs shows no pill: it shows the terminal icon of the row.
 */
export function terminalThreadStatusLabel(
  terminal: TerminalThreadState | undefined,
  lastVisitedAt: string | null | undefined,
): TerminalThreadStatusLabel | null {
  if (!terminal) return null;
  if (terminal.status === "error") return "Error";
  if (terminal.status === "starting") return "Connecting";
  const { attention } = terminal;
  if (!attention || !attentionIsUnseen(attention, lastVisitedAt)) return null;
  return attention.kind === "bell" ? "Awaiting Input" : "Completed";
}

type RowStatus = "approval" | "input" | "working" | "waiting" | "failed" | "limited" | "ready";

/**
 * Fork: the status of a terminal thread row in the main sidebar. Message runs keep their own
 * status, so the terminal only fills in an idle row. A bell shows Input, a failed session shows
 * Failed, and a starting session shows Working. `Completed` is the unread dot (`unread` below).
 */
export function terminalThreadRowStatus<Status extends RowStatus>(
  status: Status,
  label: TerminalThreadStatusLabel | null,
): Status | "input" | "failed" | "working" {
  if (status !== "ready" && status !== "waiting") return status;
  if (label === "Awaiting Input") return "input";
  if (label === "Error") return "failed";
  if (label === "Connecting") return "working";
  return status;
}
