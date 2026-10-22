/**
 * Fork: the pure part of the `terminal` provider driver. A message becomes shell input. At an
 * idle shell the input carries a completion marker, so the run learns the exit code and the
 * output of the command. The setup script runner uses the same marker technique.
 */
import { stripTerminalControl } from "../../project/ProjectSetupScriptRunner.ts";

/** A run that has no marker after this long ends with a "still running" message. */
export const TERMINAL_RUN_TIMEOUT_MS = 10 * 60_000;
/** The run keeps the last characters of the output. The terminal view holds the rest. */
export const TERMINAL_OUTPUT_MAX_CHARS = 20_000;

const SENTINEL_PREFIX = "__T3_TERMINAL_DONE__";
const PARTIAL_LINE_MAX_CHARS = 4_096;

export function completionSentinel(token: string): string {
  return `${SENTINEL_PREFIX}_${token}:`;
}

/** Reads the exit code after the sentinel. The echoed wrapper has no digits there. */
function exitCodeAfterSentinel(line: string, sentinel: string): number | null | undefined {
  const start = line.indexOf(sentinel);
  if (start < 0) return undefined;
  let end = start + sentinel.length;
  if (line[end] === "-") end += 1;
  const digitsStart = end;
  while (end < line.length && line[end] !== undefined && "0123456789".includes(line[end]!))
    end += 1;
  if (end === digitsStart) return undefined;
  const code = Number(line.slice(start + sentinel.length, end));
  return Number.isFinite(code) ? code : null;
}

export interface CompletionResult {
  /** Null when the terminal ended before the marker arrived. */
  readonly exitCode: number | null;
  readonly output: string;
  readonly truncated: boolean;
}

/**
 * Collects the output of one command. `echoedWrapperLines` are the lines that the shell echoes
 * back from the typed input: they are not output.
 */
export function makeCompletionCollector(input: {
  readonly sentinel: string;
  readonly echoedWrapperLines: ReadonlyArray<string>;
}) {
  let partial = "";
  let lines: Array<string> = [];
  let length = 0;
  let truncated = false;
  let exitCode: number | null | undefined;

  const keepLine = (raw: string) => {
    const cleaned = stripTerminalControl(raw).trimEnd();
    if (
      cleaned.length === 0 ||
      cleaned.includes(input.sentinel) ||
      input.echoedWrapperLines.some((echoed) => cleaned.endsWith(echoed))
    ) {
      return;
    }
    lines.push(cleaned);
    length += cleaned.length + 1;
    while (length > TERMINAL_OUTPUT_MAX_CHARS && lines.length > 1) {
      length -= (lines.shift()?.length ?? 0) + 1;
      truncated = true;
    }
  };

  return {
    /** Returns true once the marker arrived. */
    push(data: string): boolean {
      if (exitCode !== undefined) return true;
      // A bare carriage return redraws a progress line in place; each redraw is a line.
      const parts = (partial + data).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
      partial = parts.pop() ?? "";
      if (partial.length > PARTIAL_LINE_MAX_CHARS) partial = partial.slice(-PARTIAL_LINE_MAX_CHARS);
      for (const line of parts) {
        const code = exitCodeAfterSentinel(line, input.sentinel);
        if (code !== undefined) {
          exitCode = code;
          return true;
        }
        keepLine(line);
      }
      // The marker can sit in the partial line when the shell prints no trailing newline.
      const tail = exitCodeAfterSentinel(partial, input.sentinel);
      if (tail !== undefined) exitCode = tail;
      return exitCode !== undefined;
    },
    /** The output so far, with the exit code when the marker arrived. */
    result(): CompletionResult {
      return {
        exitCode: exitCode ?? null,
        output: lines.join("\n"),
        truncated,
      };
    },
  };
}

function outputBlock(result: CompletionResult): string {
  if (result.output.length === 0) return "No output.";
  const note = result.truncated ? "Output was shortened to the last lines.\n" : "";
  return `${note}\`\`\`text\n${result.output}\n\`\`\``;
}

export function formatCompletedRun(result: CompletionResult): string {
  return result.exitCode === null
    ? `The terminal ended before the command finished.\n\n${outputBlock(result)}`
    : `Exit code ${result.exitCode}.\n\n${outputBlock(result)}`;
}

export function formatTimedOutRun(result: CompletionResult): string {
  const minutes = Math.round(TERMINAL_RUN_TIMEOUT_MS / 60_000);
  return `The command still runs after ${minutes} minutes. Open the terminal to follow it.\n\n${outputBlock(result)}`;
}

export const TYPED_INTO_PROGRAM_MESSAGE =
  "Typed into the program that runs in the terminal. Its output is not captured.";

export const SHELL_ENDED_MESSAGE =
  "The shell exited, so the terminal session is closed. The next message starts a new one.";
