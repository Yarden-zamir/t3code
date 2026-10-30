import type { ContextMenuItem, KeybindingCommand } from "@t3tools/contracts";
import type { AppRouter } from "./router";

const KEYBINDS_ITEM_ID_PREFIX = "t3.keybinds:";

export interface KeybindsMenu {
  readonly items: readonly ContextMenuItem[];
  /** The command of each added "Keybinds" item, by item id. */
  readonly commandById: ReadonlyMap<string, KeybindingCommand>;
}

function collectBindableItems(
  items: readonly ContextMenuItem[],
  found: Map<KeybindingCommand, string>,
): void {
  for (const item of items) {
    if (item.keybindingCommand !== undefined && !found.has(item.keybindingCommand)) {
      found.set(item.keybindingCommand, item.label);
    }
    if (item.children) collectBindableItems(item.children, found);
  }
}

/**
 * Appends a "Keybinds" entry for the items that have a `keybindingCommand`. It is a menu item and
 * not a button in each row, because native menus cannot show a button inside an item.
 */
export function withKeybindsEntry(items: readonly ContextMenuItem[]): KeybindsMenu {
  const found = new Map<KeybindingCommand, string>();
  collectBindableItems(items, found);
  const entries = [...found].map(([command, label]) => ({
    id: `${KEYBINDS_ITEM_ID_PREFIX}${command}`,
    command,
    label,
  }));
  const commandById = new Map(entries.map((entry) => [entry.id, entry.command]));
  const [first] = entries;
  if (first === undefined) return { items, commandById };
  const entry: ContextMenuItem =
    entries.length === 1
      ? { id: first.id, label: `Keybinds: ${first.label}`, icon: "keyboard" }
      : {
          id: `${KEYBINDS_ITEM_ID_PREFIX}menu`,
          label: "Keybinds",
          icon: "keyboard",
          children: entries.map(({ id, label }) => ({ id, label })),
        };
  return { items: [...items, { ...entry, separatorBefore: true }], commandById };
}

let openKeybindings: ((command: KeybindingCommand) => void) | null = null;

/** Lets menus outside React open the Keybindings page. `appInit` calls it once. */
export function installKeybindsMenuNavigation(router: AppRouter): void {
  openKeybindings = (command) => {
    void router.navigate({ to: "/settings/keybindings", search: { command } });
  };
}

export function openKeybindingsForCommand(command: KeybindingCommand): void {
  if (openKeybindings === null) throw new Error("Keybinds menu navigation is not installed.");
  openKeybindings(command);
}
