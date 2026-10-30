import type { ContextMenuItem, KeybindingCommand, KeybindingShortcut } from "@t3tools/contracts";

type ShowMenu = (
  items: readonly ContextMenuItem[],
  position: { x: number; y: number },
) => Promise<string | null>;

export interface ContextMenuKeybindings {
  readonly open: (command: KeybindingCommand) => void;
  /** The key that a hint shows for `command`, or null while hints are off or it has none. */
  readonly shortcutFor: (command: KeybindingCommand) => KeybindingShortcut | null;
}

// `appInit` installs these, so the menu modules do not import the router and app state.
let installed: ContextMenuKeybindings | null = null;

export function installContextMenuKeybindings(keybindings: ContextMenuKeybindings): void {
  installed = keybindings;
}

/** Adds the `shortcut` of each item with a `keybindingCommand`, for menus that cannot read it. */
export function withShortcuts<T extends string>(
  items: readonly ContextMenuItem<T>[],
  shortcutFor: ContextMenuKeybindings["shortcutFor"] = (command) =>
    installed?.shortcutFor(command) ?? null,
): ContextMenuItem<T>[] {
  return items.map((item) => {
    const shortcut = item.keybindingCommand ? shortcutFor(item.keybindingCommand) : null;
    const children = item.children ? withShortcuts(item.children, shortcutFor) : undefined;
    return {
      ...item,
      ...(shortcut ? { shortcut } : {}),
      ...(children ? { children } : {}),
    };
  });
}

const ITEM_MENU: readonly ContextMenuItem[] = [
  { id: "keybinds", label: "Keybinds…", icon: "keyboard" },
];

/** The menu of one menu item: the command to open in Keybindings, or null when dismissed. */
export async function pickItemMenuCommand(
  command: KeybindingCommand,
  position: { x: number; y: number },
  show: ShowMenu,
): Promise<KeybindingCommand | null> {
  return (await show(ITEM_MENU, position)) === "keybinds" ? command : null;
}

export async function openItemMenu(
  command: KeybindingCommand,
  position: { x: number; y: number },
  show: ShowMenu,
): Promise<void> {
  const picked = await pickItemMenuCommand(command, position, show);
  if (picked === null) return;
  if (installed === null) throw new Error("Context menu keybindings are not installed.");
  installed.open(picked);
}

/** Shift+F10 and the context menu key open the menu of the focused menu item. */
export function isItemMenuKey(event: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}
