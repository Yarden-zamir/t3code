/**
 * Fork: the state of the shell of a terminal thread, from the marks that its shell integration
 * prints (`shellMarks.ts`). The manager keeps these fields on a terminal session and the summary
 * of the terminal reports them: the sidebar of a client reads `shell`, `hasRunningSubprocess` and
 * `attention` from there, and a new terminal thread takes its title from `command`.
 */
import {
  TERMINAL_COMMAND_MAX_LENGTH,
  type TerminalAttention,
  type TerminalShellState,
} from "@t3tools/contracts";

import type { ShellItem } from "./shellMarks.ts";

export interface ShellStateHolder {
  shell: TerminalShellState | null;
  /** Epoch milliseconds of the last change of `shell`, or of a poll that saw a child process. */
  shellConfirmedAt: number;
  attention: TerminalAttention | null;
  hasRunningSubprocess: boolean;
  /** The command line of the last command that started. */
  command: string | null;
}

// A bell storm raises one attention per second, so the sidebar does not repaint on each ring.
const BELL_MIN_INTERVAL_MS = 1000;

/**
 * A shell that starts or runs a command for this long with no child process may have stopped
 * reporting: `exec zsh` replaces it with a shell without the hook, and a `.bashrc` that runs
 * `exec zsh` never shows the hooked prompt. A builtin that waits (`read`) or a loop of builtins
 * looks the same, so those also lose their state after this long. Revisit when that matters.
 */
export const UNCONFIRMED_SHELL_STATE_MS = 10_000;

/** Forgets a `starting` or `running` state that no child process confirms. */
export function forgetUnconfirmedShellState(
  session: ShellStateHolder,
  hasChildProcess: boolean,
  nowMs: number,
): boolean {
  if (session.shell !== "starting" && session.shell !== "running") return false;
  if (hasChildProcess) {
    session.shellConfirmedAt = nowMs;
    return false;
  }
  if (nowMs - session.shellConfirmedAt < UNCONFIRMED_SHELL_STATE_MS) return false;
  session.shell = null;
  session.shellConfirmedAt = nowMs;
  session.hasRunningSubprocess = false;
  return true;
}

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
    if (key === "shell") session.shellConfirmedAt = Date.parse(at);
    changed = true;
  };
  for (const item of items) {
    switch (item.type) {
      case "text":
      case "continuation":
        break;
      case "prompt":
        set("shell", "prompt");
        set("hasRunningSubprocess", false);
        break;
      case "commandStart": {
        set("shell", "running");
        set("hasRunningSubprocess", true);
        const command = item.commandLine?.trim().slice(0, TERMINAL_COMMAND_MAX_LENGTH);
        if (command) set("command", command);
        break;
      }
      case "commandEnd":
        // The first prompt of a shell reports an end without a command.
        if (session.shell === "running") {
          const previous = session.attention;
          const bellAt = previous?.kind === "bell" ? previous.at : previous?.bellAt;
          session.attention = {
            kind: "finished",
            at,
            exitCode: item.exitCode,
            ...(bellAt === undefined ? {} : { bellAt }),
          };
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
