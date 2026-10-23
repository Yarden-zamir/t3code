// Fork: "terminal-thread" is the main terminal of a terminal thread (`forkTerminalThreads.ts`).
export type TerminalFocusOwner = "drawer" | "right-panel" | "terminal-thread";

export function getTerminalFocusOwner(): TerminalFocusOwner | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  if (!activeElement.isConnected) return null;
  const owner = activeElement.closest<HTMLElement>("[data-terminal-owner]")?.dataset.terminalOwner;
  if (owner === "drawer" || owner === "right-panel" || owner === "terminal-thread") return owner;
  return null;
}

export function isTerminalFocused(): boolean {
  return getTerminalFocusOwner() !== null;
}

/**
 * Fork: whether a Ctrl chord in the main terminal of a terminal thread goes to the shell before
 * the terminal pane shortcuts. `mod` is Ctrl on Linux and Windows, where Ctrl+D, Ctrl+W, Ctrl+N
 * and Ctrl+J are shell keys. On macOS `mod` is Cmd, so the pane shortcuts keep working there.
 */
export function isTerminalThreadShellKey(event: {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): boolean {
  return event.ctrlKey && !event.metaKey && getTerminalFocusOwner() === "terminal-thread";
}
