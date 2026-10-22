/**
 * Fork: terminal threads, behind the server setting `terminalThreads`. A terminal thread is an
 * ordinary thread whose provider instance is `TERMINAL_THREAD_INSTANCE_ID`. Its main view is the
 * thread terminal `DEFAULT_TERMINAL_ID`. A message to the thread is typed into that terminal
 * (the `terminal` provider driver). With the server setting `terminalThreadsTmux`, the terminal
 * runs inside a tmux session, so its apps outlive a server restart.
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

/**
 * The bytes that open the tmux search prompt. The tmux config of the server binds them as a user
 * key, so they never reach the app. A key mapping sends them (`TMUX_KEY_PRESET`).
 */
export const TERMINAL_THREAD_FIND_SEQUENCE = "\u001b[1999~";

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
});
export type TerminalAttention = typeof TerminalAttention.Type;
