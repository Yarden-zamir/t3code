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

/**
 * Fork: marks a control with menu entries of its own, such as "Settings: Microphone". They show
 * in the same item menu as "Keybindings…", before it. `controlMenuProps` sets both.
 */
export const CONTROL_MENU_ATTRIBUTE = "data-control-menu";

export type ControlMenuEntry = {
  readonly label: string;
  readonly run: () => void;
  /** An icon name of `ContextMenuItem.icon`. */
  readonly icon?: string;
  /** The command that runs the same action; the menu shows its key and links to its bindings. */
  readonly keybindingCommand?: KeybindingCommand;
};

const controlMenuEntries = new WeakMap<Element, readonly ControlMenuEntry[]>();

/** Props of a control that has its own menu entries. Spread them on the element. */
export function controlMenuProps(entries: readonly ControlMenuEntry[]) {
  if (entries.length === 0) return {};
  return {
    [CONTROL_MENU_ATTRIBUTE]: "",
    ref: (element: Element | null) => {
      if (element !== null) controlMenuEntries.set(element, entries);
    },
  };
}

const KEYBINDINGS_ITEM_LABEL = "Keybindings…";

// `appInit` installs this, so the menu modules do not import the router.
let openKeybindings: OpenKeybindings | null = null;
// Windows sends `contextmenu` after the key goes up. It must not reach the element that has
// focus by then and open that element's own menu.
let ignoreNextContextMenu = false;

const isKeybindingCommand = Schema.is(KeybindingCommandSchema);

/**
 * The commands of the bindable element at or around `target`, or null. A control that runs two
 * commands, such as the compact effort and mode picker, lists both, separated by a space.
 */
export function bindableElement(target: EventTarget | null): {
  readonly element: HTMLElement;
  readonly commands: readonly KeybindingCommand[];
  /** Fork: the control's own entries, before "Keybindings…". */
  readonly entries: readonly ControlMenuEntry[];
} | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(
    `[${KEYBINDING_COMMAND_ATTRIBUTE}], [${CONTROL_MENU_ATTRIBUTE}]`,
  );
  if (element === null) return null;
  const attribute = element.getAttribute(KEYBINDING_COMMAND_ATTRIBUTE);
  const names = attribute === null ? [] : attribute.split(" ");
  const commands = names.filter(isKeybindingCommand);
  if (attribute !== null && (commands.length === 0 || commands.length !== names.length)) {
    throw new Error(`${KEYBINDING_COMMAND_ATTRIBUTE} names no keybinding command: ${names}`);
  }
  const entries = controlMenuEntries.get(element) ?? [];
  if (commands.length === 0 && entries.length === 0) return null;
  return { element, commands, entries };
}

/** One "Keybindings…" entry per command; with two, each names its command, such as "Mode". */
export function keybindingsEntries(
  commands: readonly KeybindingCommand[],
): ReadonlyArray<{ readonly label: string; readonly command: KeybindingCommand }> {
  if (commands.length === 1)
    return commands.map((command) => ({ label: KEYBINDINGS_ITEM_LABEL, command }));
  return commands.map((command) => {
    const name = command.split(".").at(-1) ?? command;
    return {
      label: `Keybindings for ${name.charAt(0).toUpperCase()}${name.slice(1)}…`,
      command,
    };
  });
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
  void openItemMenu(bindable, { position: { x: event.clientX, y: event.clientY } });
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
  void openItemMenu(bindable, { element: bindable.element });
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

export function openKeybindingsFor(command: KeybindingCommand): void {
  if (openKeybindings === null) throw new Error("Context menu keybindings are not installed.");
  openKeybindings(command);
}

/** The item menu of a bindable element outside a Base UI menu, as an app menu. */
async function openItemMenu(
  bindable: {
    readonly commands: readonly KeybindingCommand[];
    readonly entries: readonly ControlMenuEntry[];
  },
  opener: { readonly element: Element } | { readonly position: { x: number; y: number } },
): Promise<void> {
  const { commands, entries: controlEntries } = bindable;
  let position: { x: number; y: number };
  if ("element" in opener) {
    ignoreContextMenuAfterKey();
    const rect = opener.element.getBoundingClientRect();
    position = { x: rect.left, y: rect.bottom };
  } else {
    position = opener.position;
  }
  const entries = keybindingsEntries(commands);
  const items: ContextMenuItem[] = [
    ...controlEntries.map((entry, index) => ({
      id: `control:${index}`,
      label: entry.label,
      ...(entry.icon === undefined ? {} : { icon: entry.icon }),
      ...(entry.keybindingCommand === undefined
        ? {}
        : { keybindingCommand: entry.keybindingCommand }),
    })),
    ...entries.map((entry, index) => ({
      id: `key:${index}`,
      label: entry.label,
      icon: "keyboard",
      ...(index === 0 && controlEntries.length > 0 ? { separatorBefore: true } : {}),
    })),
  ];
  const selection = requestForkContextMenu(items, position);
  const picked = selection === undefined ? null : await selection;
  if (picked === null) return;
  const [kind, index] = picked.split(":");
  if (kind === "control") controlEntries[Number(index)]?.run();
  else {
    const entry = entries[Number(index)];
    if (entry !== undefined) openKeybindingsFor(entry.command);
  }
}
