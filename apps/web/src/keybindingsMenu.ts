import {
  type ContextMenuItem,
  KeybindingCommand as KeybindingCommandSchema,
  type KeybindingCommand,
} from "@t3tools/contracts";
import { Schema } from "effect";

import { requestForkContextMenu } from "./forkContextMenu";

type OpenKeybindings = (command: KeybindingCommand) => void;

/**
 * Marks an element that runs a keybinding command. Right-click or Shift+F10 on it opens its item
 * menu: nested in the menu inside a Base UI menu (`MenuPopup`), as an app menu anywhere else.
 */
export const KEYBINDING_COMMAND_ATTRIBUTE = "data-keybinding-command";

// `appInit` installs this, so the menu modules do not import the router.
let openKeybindings: OpenKeybindings | null = null;
// Windows sends `contextmenu` after the key goes up. It must not reach the element that has
// focus by then and open that element's own menu.
let ignoreNextContextMenu = false;

const isKeybindingCommand = Schema.is(KeybindingCommandSchema);

/** The command of the bindable element at or around `target`, or null. */
export function bindableElement(
  target: EventTarget | null,
): { readonly element: HTMLElement; readonly command: KeybindingCommand } | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(`[${KEYBINDING_COMMAND_ATTRIBUTE}]`);
  if (element === null) return null;
  const command = element.getAttribute(KEYBINDING_COMMAND_ATTRIBUTE);
  if (!isKeybindingCommand(command)) {
    throw new Error(`${KEYBINDING_COMMAND_ATTRIBUTE} names no keybinding command: ${command}`);
  }
  return { element, command };
}

// Text fields keep the browser menu, and menus open the item menu nested in themselves.
const OWN_MENU_SELECTOR =
  'input, textarea, [contenteditable=""], [contenteditable="true"], [data-slot="menu-popup"]';

function bindableOutsideMenus(target: EventTarget | null) {
  if (!(target instanceof Element) || target.closest(OWN_MENU_SELECTOR)) return null;
  return bindableElement(target);
}

/** Text selected inside `target`: its right-click keeps the browser menu, with Copy. */
export function selectionInside(target: EventTarget | null): boolean {
  const selection = window.getSelection();
  return (
    target instanceof Node &&
    selection !== null &&
    !selection.isCollapsed &&
    (target.contains(selection.anchorNode) || target.contains(selection.focusNode))
  );
}

function onContextMenu(event: MouseEvent): void {
  if (ignoreNextContextMenu) {
    ignoreNextContextMenu = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const bindable = bindableOutsideMenus(event.target);
  if (bindable === null || selectionInside(bindable.element)) return;
  event.preventDefault();
  event.stopPropagation();
  void openItemMenu(bindable.command, { position: { x: event.clientX, y: event.clientY } });
}

function onKeyDown(event: KeyboardEvent): void {
  if (!isItemMenuKey(event)) {
    ignoreNextContextMenu = false;
    return;
  }
  const bindable = bindableOutsideMenus(event.target);
  if (bindable === null) return;
  event.preventDefault();
  event.stopPropagation();
  void openItemMenu(bindable.command, { element: bindable.element });
}

// macOS sends no `contextmenu` for the key, so the next pointer clears the flag.
function clearIgnore(): void {
  ignoreNextContextMenu = false;
}

export function installContextMenuKeybindings(open: OpenKeybindings): void {
  if (openKeybindings === null) {
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("pointerdown", clearIgnore, true);
    window.addEventListener("keydown", onKeyDown, true);
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

/** The item menu of a bindable element outside a Base UI menu, as an app menu. */
async function openItemMenu(
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
