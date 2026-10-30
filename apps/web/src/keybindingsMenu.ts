import type { ContextMenuItem, KeybindingCommand } from "@t3tools/contracts";

type OpenKeybindings = (command: KeybindingCommand) => void;
type ShowMenu = (
  items: readonly ContextMenuItem[],
  position: { x: number; y: number },
) => Promise<string | null>;

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

const ITEM_MENU: readonly ContextMenuItem[] = [
  { id: "keybinds", label: "Keybinds…", icon: "keyboard" },
];

/** The menu of one menu item. A key opens it below the item, a right-click at the pointer. */
export async function openItemMenu(
  command: KeybindingCommand,
  opener: { readonly element: Element } | { readonly position: { x: number; y: number } },
  show: ShowMenu,
): Promise<void> {
  let position: { x: number; y: number };
  if ("element" in opener) {
    ignoreNextContextMenu = true;
    const rect = opener.element.getBoundingClientRect();
    position = { x: rect.left, y: rect.bottom };
  } else {
    position = opener.position;
  }
  if ((await show(ITEM_MENU, position)) !== "keybinds") return;
  if (openKeybindings === null) throw new Error("Context menu keybindings are not installed.");
  openKeybindings(command);
}
