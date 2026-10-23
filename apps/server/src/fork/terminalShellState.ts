/**
 * Fork: the state of the shell of a terminal thread, from the marks that its shell integration
 * prints (`shellMarks.ts`). The manager keeps these fields on a terminal session and the summary
 * of the terminal reports them: the sidebar of a client reads `shell`, `hasRunningSubprocess` and
 * `attention` from there.
 */
import type { TerminalAttention, TerminalShellState } from "@t3tools/contracts";

import type { ShellItem } from "./shellMarks.ts";

export interface ShellStateHolder {
  shell: TerminalShellState | null;
  attention: TerminalAttention | null;
  hasRunningSubprocess: boolean;
}

// A bell storm raises one attention per second, so the sidebar does not repaint on each ring.
const BELL_MIN_INTERVAL_MS = 1000;

/** Applies the marks of one chunk of output. Returns true when a reported field changed. */
export function applyShellItems(
  session: ShellStateHolder,
  items: ReadonlyArray<ShellItem>,
  at: string,
): boolean {
  let changed = false;
  const set = <K extends keyof ShellStateHolder>(key: K, value: ShellStateHolder[K]) => {
    if (session[key] === value) return;
    session[key] = value;
    changed = true;
  };
  for (const item of items) {
    switch (item.type) {
      case "text":
        break;
      case "prompt":
        set("shell", "prompt");
        set("hasRunningSubprocess", false);
        break;
      case "commandStart":
        set("shell", "running");
        set("hasRunningSubprocess", true);
        break;
      case "commandEnd":
        // The first prompt of a shell reports an end without a command.
        if (session.shell === "running") {
          session.attention = { kind: "finished", at, exitCode: item.exitCode };
          changed = true;
        }
        set("shell", "prompt");
        set("hasRunningSubprocess", false);
        break;
      case "attention": {
        const previous = session.attention;
        if (
          previous?.kind === "bell" &&
          Date.parse(at) - Date.parse(previous.at) < BELL_MIN_INTERVAL_MS
        ) {
          break;
        }
        session.attention = { kind: "bell", at };
        changed = true;
        break;
      }
    }
  }
  return changed;
}
