/**
 * Fork: terminal threads, behind the server setting `terminalThreads`. A terminal thread is an
 * ordinary thread whose provider instance is `TERMINAL_THREAD_INSTANCE_ID`. Its screen is the
 * thread terminal `DEFAULT_TERMINAL_ID`. A message to the thread is typed into that terminal (the
 * `terminal` provider driver).
 */
import * as Schema from "effect/Schema";

import type { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const TERMINAL_THREAD_INSTANCE_ID = ProviderInstanceId.make("terminal");

export const TERMINAL_THREAD_MODEL_SELECTION: ModelSelection = {
  instanceId: TERMINAL_THREAD_INSTANCE_ID,
  model: "terminal",
};

/** The client opens the main terminal of a terminal thread with this variable set to "1". */
export const TERMINAL_THREAD_ENV = "T3CODE_TERMINAL_THREAD";

export function isTerminalThread(thread: { readonly providerInstanceId: string }): boolean {
  return thread.providerInstanceId === TERMINAL_THREAD_INSTANCE_ID;
}

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
 * Where the shell of a terminal thread stands, as its shell integration reports it. `prompt` waits
 * for a command and `running` runs one. A terminal without shell integration has no state.
 */
export const TerminalShellState = Schema.Literals(["prompt", "running"]);
export type TerminalShellState = typeof TerminalShellState.Type;
