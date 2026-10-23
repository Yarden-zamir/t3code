/**
 * Fork: the pure part of the `terminal` provider driver. A message becomes shell input. With the
 * shell integration of a terminal thread (`../shellIntegration.ts`), the run reads the output and
 * the exit code of the command from the marks of the shell, so the terminal shows only what the
 * message said.
 */
import { stripTerminalControl } from "../../project/ProjectSetupScriptRunner.ts";
import type { ShellItem } from "../shellMarks.ts";

/** A run that does not end after this long ends with a "still running" message. */
export const TERMINAL_RUN_TIMEOUT_MS = 10 * 60_000;
/** The shell prints its first prompt after its startup files ran, which can take a while. */
export const SHELL_READY_TIMEOUT_MS = 10_000;
/** The run keeps the last characters of the output. The terminal view holds the rest. */
export const TERMINAL_OUTPUT_MAX_CHARS = 20_000;

export interface CommandResult {
  /** Null when the shell ended or the run timed out before the command ended. */
  readonly exitCode: number | null;
  readonly output: string;
  readonly truncated: boolean;
}

/**
 * Collects the output of the first command that starts after it was created. The shell echoes
 * the typed message before the command starts, so the echo is not part of the output.
 */
export function makeCommandCapture() {
  let running = false;
  let text = "";
  let exitCode: number | null = null;
  let done = false;

  return {
    /** Returns true once the command ended. */
    push(items: ReadonlyArray<ShellItem>): boolean {
      for (const item of items) {
        if (done) break;
        if (item.type === "commandStart") {
          running = true;
          text = "";
        } else if (item.type === "text" && running) {
          text += item.text;
        } else if (item.type === "commandEnd" && running) {
          exitCode = item.exitCode;
          done = true;
        }
      }
      return done;
    },
    result(): CommandResult {
      // A bare carriage return redraws a progress line in place; each redraw is a line.
      const lines = stripTerminalControl(text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"))
        .split("\n")
        .map((line) => line.trimEnd());
      let output = lines.join("\n").trim();
      const truncated = output.length > TERMINAL_OUTPUT_MAX_CHARS;
      if (truncated) output = output.slice(-TERMINAL_OUTPUT_MAX_CHARS);
      return { exitCode, output, truncated };
    },
  };
}

function outputBlock(result: CommandResult): string {
  if (result.output.length === 0) return "No output.";
  const note = result.truncated ? "Output was shortened to the last characters.\n" : "";
  return `${note}\`\`\`text\n${result.output}\n\`\`\``;
}

export function formatCompletedRun(result: CommandResult): string {
  return `${result.exitCode === null ? "The command ended without an exit code." : `Exit code ${result.exitCode}.`}\n\n${outputBlock(result)}`;
}

export function formatTimedOutRun(result: CommandResult): string {
  const minutes = Math.round(TERMINAL_RUN_TIMEOUT_MS / 60_000);
  return `The command still runs after ${minutes} minutes. Open the terminal to follow it.\n\n${outputBlock(result)}`;
}

export const TYPED_INTO_PROGRAM_MESSAGE =
  "Typed into the program that runs in the terminal. Its output is not captured.";

export const TYPED_WITHOUT_RESULT_MESSAGE =
  "Typed into the terminal. This shell does not report results, so the exit code and output are not captured. Use bash or zsh for results.";

export const SHELL_ENDED_MESSAGE =
  "The shell exited, so the terminal session is closed. The next message starts a new one.";
