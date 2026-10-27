import type { ContextMenuItem } from "@t3tools/contracts";

import { getClientSettings } from "./hooks/useSettings";

/**
 * Fork: the open request of the app's own context menu (`richContextMenu`). The host,
 * `ForkContextMenuHost`, draws it; one request at a time, like a system menu.
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
let registeredHostCount = 0;
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

export function registerForkContextMenuHost(): () => void {
  registeredHostCount += 1;
  return () => {
    registeredHostCount -= 1;
    if (registeredHostCount === 0) dismissForkContextMenu();
  };
}

/** A keyboard opener passes no position; the menu then opens below the focused element. */
function defaultPosition(focused: HTMLElement | null): { x: number; y: number } {
  if (!focused || focused === document.body) return { x: 0, y: 0 };
  const rect = focused.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

/** Undefined means the caller keeps its own menu: the setting is off or no host is mounted. */
export function requestForkContextMenu<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> | undefined {
  if (registeredHostCount === 0 || !getClientSettings().richContextMenu) return undefined;
  dismissForkContextMenu();
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
