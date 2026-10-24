/**
 * Fork: terminal threads, behind the server setting `terminalThreads`. A terminal thread is an
 * ordinary thread whose provider instance is `TERMINAL_THREAD_INSTANCE_ID`. Its screen is the
 * thread terminal `DEFAULT_TERMINAL_ID`. A message to the thread is typed into that terminal (the
 * `terminal` provider driver).
 */
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const TERMINAL_THREAD_INSTANCE_ID = ProviderInstanceId.make("terminal");

/**
 * The model of a terminal thread is its shell: a shell slug such as `zsh`, from the models of the
 * `terminal` provider. This legacy model `terminal` means the default shell of the server.
 */
export const TERMINAL_THREAD_MODEL_SELECTION: ModelSelection = {
  instanceId: TERMINAL_THREAD_INSTANCE_ID,
  model: "terminal",
};

/** The `shell` that opens the main terminal of a terminal thread; undefined for the default. */
export function terminalThreadShell(model: string): string | undefined {
  return model === TERMINAL_THREAD_MODEL_SELECTION.model ? undefined : model;
}

/** The shells that the server detects by these names (`fork/terminalShells.ts`). */
export const TERMINAL_SHELL_NAMES = [
  "zsh",
  "bash",
  "fish",
  "sh",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
  "pwsh",
  "powershell",
  "cmd",
] as const;
export type TerminalShellName = (typeof TERMINAL_SHELL_NAMES)[number];

/**
 * Model names that a custom shell cannot take: every name that detection can find, also one that
 * is not installed now, so a later install never changes what a thread runs.
 */
function isReservedTerminalShellName(name: string): boolean {
  return (
    name === TERMINAL_THREAD_MODEL_SELECTION.model ||
    TERMINAL_SHELL_NAMES.some((reserved) => reserved === name.toLowerCase())
  );
}

/**
 * A shell that the user defines in the settings of the `terminal` provider: any executable with
 * its arguments, such as `uv` with `run python`. Its name is its model slug.
 */
export const TerminalCustomShell = Schema.Struct({
  name: TrimmedNonEmptyString.check(
    Schema.makeFilter(
      (name: string) =>
        !isReservedTerminalShellName(name) ||
        `"${name}" is the name of a detected shell. Choose another name.`,
    ),
  ),
  /** A path, or a name that the server finds on the PATH of the terminal. */
  executable: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
});
export type TerminalCustomShell = typeof TerminalCustomShell.Type;

export const TerminalCustomShells = Schema.Array(TerminalCustomShell).check(
  Schema.makeFilter(
    (shells: ReadonlyArray<TerminalCustomShell>) =>
      new Set(shells.map((shell) => shell.name)).size === shells.length ||
      "Two custom shells have the same name.",
  ),
);

/** `TerminalSummary.command` keeps at most this many characters of a command line. */
export const TERMINAL_COMMAND_MAX_LENGTH = 200;

const TERMINAL_THREAD_TITLE_MAX_LENGTH = 80;

/**
 * The title of a new terminal thread: its command line, else the program that runs, else its
 * shell. A shell without the hook (a custom shell, a drawer terminal) reports no command line.
 * Typed keys are no command line either, because of line editing, completion and history.
 */
export function terminalThreadTitle(source: {
  readonly command: string | undefined;
  /** The program that runs in the shell, when the server saw one. */
  readonly program?: string | undefined;
  /** The shell slug, undefined for the default shell. */
  readonly shell: string | undefined;
}): string {
  const title = [source.command, source.program, source.shell]
    .map((value) => value?.trim())
    .find((value) => value !== undefined && value.length > 0);
  return (title ?? "Terminal").slice(0, TERMINAL_THREAD_TITLE_MAX_LENGTH);
}

/**
 * The title that a terminal thread gets from its first command, or null to keep its title. A
 * thread that started without a command (the enlarge button) has the title of no command, which
 * is the shell name for a named shell.
 */
export function terminalThreadCommandTitle(source: {
  readonly title: string;
  readonly command: string | undefined;
  readonly shell: string | undefined;
}): string | null {
  const command = source.command?.trim();
  if (!command) return null;
  if (source.title !== terminalThreadTitle({ command: undefined, shell: source.shell }))
    return null;
  return terminalThreadTitle({ command, shell: source.shell });
}

/** The client opens the main terminal of a terminal thread with this variable set to "1". */
export const TERMINAL_THREAD_ENV = "T3CODE_TERMINAL_THREAD";

export function isTerminalThread(thread: { readonly providerInstanceId: string }): boolean {
  return thread.providerInstanceId === TERMINAL_THREAD_INSTANCE_ID;
}

/**
 * A thread keeps its kind. An agent with the history of a shell, or a shell that receives the
 * markdown of an agent, is never what the sender meant.
 */
export function changesThreadKind(
  thread: { readonly providerInstanceId: string },
  selection: Pick<ModelSelection, "instanceId">,
): boolean {
  return isTerminalThread(thread) !== (selection.instanceId === TERMINAL_THREAD_INSTANCE_ID);
}

export const THREAD_KIND_CHANGE_MESSAGE =
  "A terminal thread cannot switch to an agent, and an agent thread cannot switch to a terminal. Start a new thread instead.";

/**
 * What a terminal thread asks of the user. `bell` is a terminal bell or an app notification
 * (OSC 9 or OSC 777). `finished` is a program that ended in the shell. The sidebar shows the
 * attention as unread until the user visits the thread after `at`.
 */
export const TerminalAttention = Schema.Struct({
  kind: Schema.Literals(["bell", "finished"]),
  at: Schema.String,
  /** The exit code of the program that ended. Only `finished` carries it. */
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  /**
   * The last bell before this program end. Only `finished` carries it, so a bell that the user
   * did not see yet still shows after the program that rang it ends.
   */
  bellAt: Schema.optionalKey(Schema.String),
});
export type TerminalAttention = typeof TerminalAttention.Type;

/**
 * Where the shell of a terminal thread stands, as its shell integration reports it. `starting`
 * runs its startup files, `prompt` waits for a command and `running` runs one. A terminal without
 * shell integration has no state, and neither has a shell that stopped reporting (`exec zsh`).
 * Old clients fail to decode a value they do not know, so add values only before a release.
 */
export const TerminalShellState = Schema.Literals(["starting", "prompt", "running"]);
export type TerminalShellState = typeof TerminalShellState.Type;

/**
 * A new worktree for a draft in Terminal mode, prepared as the launch of a chat thread prepares
 * one. The setup script runs in a terminal of `threadId`, the thread id that the draft reserves.
 */
export const ForkPrepareDraftWorktreeInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  baseRef: TrimmedNonEmptyString,
  startFromOrigin: Schema.Boolean,
});
export type ForkPrepareDraftWorktreeInput = typeof ForkPrepareDraftWorktreeInput.Type;

export const ForkPrepareDraftWorktreeResult = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  /** Null for the own folder of a draft in a scratch project. */
  branch: Schema.NullOr(TrimmedNonEmptyString),
});
export type ForkPrepareDraftWorktreeResult = typeof ForkPrepareDraftWorktreeResult.Type;

/**
 * Moves a running terminal of a drawer, with its process and its output, into a new terminal
 * thread in the same project and folder. The client reserves `newThreadId`, as a draft does, so
 * it can open the thread when the call returns.
 */
export const ForkMoveTerminalToThreadInput = Schema.Struct({
  threadId: ThreadId,
  terminalId: TrimmedNonEmptyString,
  newThreadId: ThreadId,
});
export type ForkMoveTerminalToThreadInput = typeof ForkMoveTerminalToThreadInput.Type;

export class ForkMoveTerminalToThreadError extends Schema.TaggedError<ForkMoveTerminalToThreadError>()(
  "ForkMoveTerminalToThreadError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `The terminal did not move to a terminal thread. ${this.detail}`;
  }
}
