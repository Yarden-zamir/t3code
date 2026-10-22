/**
 * Fork: terminal threads, behind the server setting `terminalThreads`. A terminal thread is an
 * ordinary thread whose provider instance is `TERMINAL_THREAD_INSTANCE_ID`. Its main view is the
 * thread terminal `DEFAULT_TERMINAL_ID`, and the server runs that terminal inside a tmux session
 * named after the thread, so vim or a CLI agent keeps running through a server restart.
 *
 * Limit: no provider instance has this id, so a message to the thread starts no turn. Schedules,
 * webhooks and agents cannot type into a terminal thread yet. Revisit with a thin provider
 * adapter that types each message into the tmux session.
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
 * The bytes that the client writes to open the tmux search prompt. The server's tmux config binds
 * them as a user key, so they never reach the app in the terminal.
 */
export const TERMINAL_THREAD_FIND_SEQUENCE = "\u001b[1999~";

/**
 * The Command keys of an editor-like ZLE setup: select all, copy, cut, undo and redo. The shell
 * binds the Kitty CSI-u Super sequence `shell`. tmux would read that sequence as a Meta key, so
 * the client sends the private sequence `wire` instead, and the tmux config of the server turns
 * it back into `shell` (`apps/server/src/fork/terminalThreads.ts`). Limit: tmux cannot carry the
 * Kitty keyboard protocol, so only these keys reach the shell. Revisit when tmux supports it.
 */
export const TERMINAL_THREAD_SUPER_KEYS = [
  { key: "a", shift: false, wire: "\u001b[2001~", shell: "\u001b[97;9u" },
  { key: "c", shift: false, wire: "\u001b[2002~", shell: "\u001b[99;9u" },
  { key: "x", shift: false, wire: "\u001b[2003~", shell: "\u001b[120;9u" },
  { key: "z", shift: false, wire: "\u001b[2004~", shell: "\u001b[122;9u" },
  { key: "z", shift: true, wire: "\u001b[2005~", shell: "\u001b[122;10u" },
] as const;

export function terminalThreadSuperKeyWire(key: string, shift: boolean): string | null {
  const lower = key.toLowerCase();
  return (
    TERMINAL_THREAD_SUPER_KEYS.find((entry) => entry.key === lower && entry.shift === shift)
      ?.wire ?? null
  );
}

export function isTerminalThread(thread: { readonly providerInstanceId: string }): boolean {
  return thread.providerInstanceId === TERMINAL_THREAD_INSTANCE_ID;
}
