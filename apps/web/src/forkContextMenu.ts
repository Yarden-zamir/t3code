import type { ContextMenuItem } from "@t3tools/contracts";

/**
 * Fork: the open request of the app's own context menu, drawn by `ForkContextMenuHost`.
 * Upstream https://github.com/pingdotgg/t3code/pull/18103 adds a desktop toggle to the web
 * menu. When it merges, move to its setting and keep this host for the later phases.
 */
export type ForkContextMenuRequest = {
  readonly key: number;
  readonly items: readonly ContextMenuItem[];
  readonly position: { readonly x: number; readonly y: number };
};

type ActiveRequest = ForkContextMenuRequest & {
  readonly resolve: (id: string | null) => void;
  readonly returnFocus: HTMLElement | null;
};

/** Marks the trigger and every popup of the menu, submenus too. */
export const FORK_CONTEXT_MENU_ATTRIBUTE = "data-fork-context-menu";

let active: ActiveRequest | null = null;
let nextKey = 0;
let hostRegistered = false;
const listeners = new Set<() => void>();

function publish(next: ActiveRequest | null): void {
  active = next;
  for (const listener of listeners) listener();
}

export function readForkContextMenu(): ForkContextMenuRequest | null {
  return active;
}

export function subscribeForkContextMenu(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The host registers while `richContextMenu` is on. */
export function registerForkContextMenuHost(): () => void {
  hostRegistered = true;
  return () => {
    hostRegistered = false;
    dismissForkContextMenu();
  };
}

/** A keyboard opener passes no position; the menu then opens below the focused element. */
function defaultPosition(focused: HTMLElement | null): { x: number; y: number } {
  if (!focused || focused === document.body) return { x: 0, y: 0 };
  const rect = focused.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

/** Undefined means the caller keeps its own menu: no host is registered. */
export function requestForkContextMenu<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> | undefined {
  if (!hostRegistered) return undefined;
  const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // A menu that replaces an open one gives focus back where the open one would have.
  const focused = current?.closest(`[${FORK_CONTEXT_MENU_ATTRIBUTE}]`)
    ? (active?.returnFocus ?? null)
    : current;
  dismissForkContextMenu();
  return new Promise<T | null>((resolve) => {
    nextKey += 1;
    publish({
      key: nextKey,
      items,
      position: position ?? defaultPosition(focused),
      // Callers only receive ids from `items`, so the id is a `T`.
      resolve: resolve as (id: string | null) => void,
      returnFocus: focused,
    });
  });
}

/**
 * Closes request `key` with the picked id, or null. Focus goes back before the caller resumes,
 * so a caller that focuses a rename field after the menu keeps that focus. Both wait a microtask,
 * because Base UI focuses the pressed item again after its click handlers.
 */
export function settleForkContextMenu(key: number, id: string | null): void {
  if (active?.key !== key) return;
  const { resolve, returnFocus } = active;
  publish(null);
  queueMicrotask(() => {
    const focusInMenu =
      document.activeElement === document.body ||
      document.activeElement?.closest(`[${FORK_CONTEXT_MENU_ATTRIBUTE}]`) != null;
    if (focusInMenu && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    resolve(id);
  });
}

export function dismissForkContextMenu(): void {
  if (active) settleForkContextMenu(active.key, null);
}

export function isForkContextMenuOpen(): boolean {
  return active !== null;
}
