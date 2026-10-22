/**
 * Fork: terminal threads, behind the server setting `terminalThreads`. A terminal thread is an
 * ordinary thread whose provider instance is `TERMINAL_THREAD_INSTANCE_ID`. Its main view is the
 * thread terminal `DEFAULT_TERMINAL_ID`. A message to the thread is typed into that terminal
 * (the `terminal` provider driver). With the server setting `terminalThreadsTmux`, the terminal
 * runs inside a tmux session, so its apps outlive a server restart.
 */
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
