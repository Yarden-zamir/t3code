/**
 * Fork: the state of the shell of a terminal thread, from the marks that its shell integration
 * prints (`shellMarks.ts`). The manager keeps these fields in the `fork` object of a terminal
 * session (`terminalSessionFork.ts`) and the summary of the terminal reports them: the sidebar of
 * a client reads `shell`, `hasRunningSubprocess` and `attention` from there, and a new terminal
 * thread takes its title from `command`.
 */
import {
  TERMINAL_COMMAND_MAX_LENGTH,
  type TerminalAttention,
  type TerminalShellState,
  terminalCommandTitle,
} from "@t3tools/contracts";

import type { ShellItem } from "./shellMarks.ts";

export interface ShellState {
  shell: TerminalShellState | null;
  /** Epoch milliseconds of the last change of `shell`, or of a poll that saw a child process. */
  shellConfirmedAt: number;
  attention: TerminalAttention | null;
  /** The program and subcommand of the last command that started (`terminalCommandTitle`). */
  command: string | null;
  /** Epoch milliseconds of the start of the last command. */
  commandStartedAt: number;
}

/** A terminal session: `hasRunningSubprocess` is an upstream field that the marks also set. */
export interface ShellStateHolder {
  hasRunningSubprocess: boolean;
  readonly fork: ShellState;
}

// A bell storm raises one attention per second, so the sidebar does not repaint on each ring.
const BELL_MIN_INTERVAL_MS = 1000;

/**
 * A command that ends sooner raises no attention. The user still watches a short command, and its
 * end is not worth a sound, a push to the phone or a move to the top of the inbox. A command that
 * takes this long is one that the user leaves to do something else.
 */
export const NOTIFIED_COMMAND_MIN_MS = 10_000;

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
  const state = session.fork;
  if (state.shell !== "starting" && state.shell !== "running") return false;
  if (hasChildProcess) {
    state.shellConfirmedAt = nowMs;
    return false;
  }
  if (nowMs - state.shellConfirmedAt < UNCONFIRMED_SHELL_STATE_MS) return false;
  state.shell = null;
  state.shellConfirmedAt = nowMs;
  session.hasRunningSubprocess = false;
  return true;
}

/** Applies the marks of one chunk of output. Returns true when a reported field changed. */
export function applyShellItems(
  session: ShellStateHolder,
  items: ReadonlyArray<ShellItem>,
  at: string,
): boolean {
  const state = session.fork;
  let changed = false;
  const setShell = (shell: TerminalShellState, programRuns: boolean) => {
    if (state.shell !== shell) {
      state.shell = shell;
      state.shellConfirmedAt = Date.parse(at);
      changed = true;
    }
    if (session.hasRunningSubprocess !== programRuns) {
      session.hasRunningSubprocess = programRuns;
      changed = true;
    }
  };
  for (const item of items) {
    switch (item.type) {
      case "text":
      case "continuation":
        break;
      case "prompt":
        setShell("prompt", false);
        break;
      case "commandStart": {
        setShell("running", true);
        state.commandStartedAt = Date.parse(at);
        const command = terminalCommandTitle(item.commandLine ?? undefined)?.slice(
          0,
          TERMINAL_COMMAND_MAX_LENGTH,
        );
        if (command !== undefined && command !== state.command) {
          state.command = command;
          changed = true;
        }
        break;
      }
      case "commandEnd":
        // The first prompt of a shell reports an end without a command.
        if (
          state.shell === "running" &&
          Date.parse(at) - state.commandStartedAt >= NOTIFIED_COMMAND_MIN_MS
        ) {
          const previous = state.attention;
          const bellAt = previous?.kind === "bell" ? previous.at : previous?.bellAt;
          state.attention = {
            kind: "finished",
            at,
            exitCode: item.exitCode,
            ...(bellAt === undefined ? {} : { bellAt }),
          };
          changed = true;
        }
        setShell("prompt", false);
        break;
      case "attention": {
        // A bell at the prompt is the line editor, such as a completion with no match.
        if (state.shell === "prompt") break;
        const previous = state.attention;
        if (
          previous?.kind === "bell" &&
          Date.parse(at) - Date.parse(previous.at) < BELL_MIN_INTERVAL_MS
        ) {
          break;
        }
        state.attention = { kind: "bell", at };
        changed = true;
        break;
      }
    }
  }
  return changed;
}
