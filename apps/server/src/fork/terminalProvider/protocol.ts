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
  /** Null when no command ran, the shell ended, or the run timed out before the command ended. */
  readonly exitCode: number | null;
  readonly output: string;
  readonly truncated: boolean;
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/**
 * Ctrl+E then Ctrl+U: clears text that the user left on the prompt line, so the message does not
 * run joined to it. Both bash and zsh keep the cleared text, and Ctrl+Y puts it back.
 */
const CLEAR_PROMPT_LINE = "\u0005\u0015";

/**
 * The input for a shell at its prompt. A bracketed paste puts all lines on one command line, so
 * the shell reports one end for the whole message, with the exit code of its last command.
 */
export function pastedCommand(text: string): string {
  return `${CLEAR_PROMPT_LINE}${PASTE_START}${text.replaceAll(PASTE_END, "").trimEnd()}${PASTE_END}\r`;
}

/**
 * Collects the output of the message that was typed at the prompt after it was created. The shell
 * was at its prompt, so the first end mark belongs to the message. A comment or an empty message
 * ends without a start mark. The shell echoes the message before the first start mark, so the
 * echo is not part of the output.
 */
export function makeCommandCapture() {
  let started = false;
  let text = "";
  let outcome:
    | { readonly type: "ended"; readonly exitCode: number | null }
    | { readonly type: "incomplete" }
    | null = null;

  return {
    /** Returns true once the command ended or the shell asks for the rest of it. */
    push(items: ReadonlyArray<ShellItem>): boolean {
      for (const item of items) {
        if (outcome !== null) break;
        switch (item.type) {
          // A message with several commands starts each of them; the output covers all.
          case "commandStart":
            started = true;
            break;
          case "text":
            if (started) text += item.text;
            break;
          case "commandEnd":
            outcome = { type: "ended", exitCode: started ? item.exitCode : null };
            break;
          case "continuation":
            outcome = { type: "incomplete" };
            break;
          case "prompt":
          case "attention":
            break;
        }
      }
      return outcome !== null;
    },
    /** True when the shell waits for the rest of an unfinished command, such as an open quote. */
    incomplete(): boolean {
      return outcome?.type === "incomplete";
    },
    result(): CommandResult {
      // A bare carriage return redraws a progress line in place; each redraw is a line.
      const lines = stripTerminalControl(text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"))
        .split("\n")
        .map((line) => line.trimEnd());
      let output = lines.join("\n").trim();
      const truncated = output.length > TERMINAL_OUTPUT_MAX_CHARS;
      if (truncated) output = output.slice(-TERMINAL_OUTPUT_MAX_CHARS);
      return { exitCode: outcome?.type === "ended" ? outcome.exitCode : null, output, truncated };
    },
  };
}

function outputBlock(result: CommandResult): string {
  if (result.output.length === 0) return "No output.";
  const note = result.truncated ? "Output was shortened to the last characters.\n" : "";
  return `${note}\`\`\`text\n${result.output}\n\`\`\``;
}

export function formatCompletedRun(result: CommandResult): string {
  return `${result.exitCode === null ? "No exit code: the message ran no command." : `Exit code ${result.exitCode}.`}\n\n${outputBlock(result)}`;
}

export function formatTimedOutRun(result: CommandResult): string {
  const minutes = Math.round(TERMINAL_RUN_TIMEOUT_MS / 60_000);
  return `The command still runs after ${minutes} minutes. Open the terminal to follow it.\n\n${outputBlock(result)}`;
}

export const BUSY_SHELL_MESSAGE =
  "A program kept the shell busy for the whole run, so the message was not typed. To type into that program, send the message as a steer while a run waits.";

export const TYPED_WITHOUT_RESULT_MESSAGE =
  "Typed into the terminal. This shell does not report results, so the exit code and output are not captured. Use bash or zsh for results.";

export const INCOMPLETE_COMMAND_MESSAGE =
  "The message is not a complete command, for example it has an open quote. The shell waited for the rest, so the message was canceled with Ctrl+C.";

export const SHELL_ENDED_MESSAGE =
  "The shell exited, so the terminal session is closed. The next message starts a new one.";
