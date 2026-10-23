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

/** `TerminalSummary.command` keeps at most this many characters of a command line. */
export const TERMINAL_COMMAND_MAX_LENGTH = 200;

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
