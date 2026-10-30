import type { ContextMenuItem, KeybindingCommand } from "@t3tools/contracts";

import { requestForkContextMenu } from "./forkContextMenu";

type OpenKeybindings = (command: KeybindingCommand) => void;

// `appInit` installs this, so the menu modules do not import the router.
let openKeybindings: OpenKeybindings | null = null;
// Windows sends `contextmenu` after the key goes up. It must not reach the element that has
// focus by then and open that element's own menu.
let ignoreNextContextMenu = false;

function onContextMenu(event: MouseEvent): void {
  if (!ignoreNextContextMenu) return;
  ignoreNextContextMenu = false;
  event.preventDefault();
  event.stopPropagation();
}

// macOS sends no `contextmenu` for the key, so the next pointer or other key clears the flag.
function clearIgnore(event: Event): void {
  if (event instanceof KeyboardEvent && isItemMenuKey(event)) return;
  ignoreNextContextMenu = false;
}

export function installContextMenuKeybindings(open: OpenKeybindings): void {
  if (openKeybindings === null) {
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("pointerdown", clearIgnore, true);
    window.addEventListener("keydown", clearIgnore, true);
  }
  openKeybindings = open;
}

/** Shift+F10 and the context menu key open the menu of the focused menu item. */
export function isItemMenuKey(event: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

/** Call when the item menu key opens a menu, so the `contextmenu` event that follows is dropped. */
export function ignoreContextMenuAfterKey(): void {
  ignoreNextContextMenu = true;
}

export const KEYBINDINGS_ITEM_LABEL = "Keybindings…";

export function openKeybindingsFor(command: KeybindingCommand): void {
  if (openKeybindings === null) throw new Error("Context menu keybindings are not installed.");
  openKeybindings(command);
}

const ITEM_MENU: readonly ContextMenuItem[] = [
  { id: "keybindings", label: KEYBINDINGS_ITEM_LABEL, icon: "keyboard" },
];

/**
 * The item menu of a row outside an app menu, such as a command palette row. Items inside an app
 * menu open it nested in that menu instead (`ForkContextMenuHost`).
 */
export async function openItemMenu(
  command: KeybindingCommand,
  opener: { readonly element: Element } | { readonly position: { x: number; y: number } },
): Promise<void> {
  let position: { x: number; y: number };
  if ("element" in opener) {
    ignoreContextMenuAfterKey();
    const rect = opener.element.getBoundingClientRect();
    position = { x: rect.left, y: rect.bottom };
  } else {
    position = opener.position;
  }
  const selection = requestForkContextMenu(ITEM_MENU, position);
  if (selection === undefined || (await selection) !== "keybindings") return;
  openKeybindingsFor(command);
}
