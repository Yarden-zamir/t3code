import type { ContextMenuItem, KeybindingCommand } from "@t3tools/contracts";
import {
  ArchiveIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  ClockIcon,
  CopyIcon,
  FolderIcon,
  FolderTreeIcon,
  GitBranchIcon,
  HashIcon,
  KeyboardIcon,
  type LucideIcon,
  MailOpenIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  SettingsIcon,
  TimerIcon,
  Trash2Icon,
  UserPlusIcon,
} from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useSyncExternalStore } from "react";

import {
  FORK_CONTEXT_MENU_ATTRIBUTE,
  readForkContextMenu,
  registerForkContextMenuHost,
  requestForkContextMenu,
  settleForkContextMenu,
  subscribeForkContextMenu,
} from "../forkContextMenu";
import { isItemMenuKey, openItemMenu } from "../keybindingsMenu";
import { ShortcutHint } from "./focusLevels/ShortcutHint";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";

/** The icon names of `ContextMenuItem.icon`, the same set as the DOM fallback menu. */
const ICONS: Record<string, LucideIcon> = {
  archive: ArchiveIcon,
  check: CheckIcon,
  timer: TimerIcon,
  "chevron-right": ChevronRightIcon,
  "circle-check": CircleCheckIcon,
  clock: ClockIcon,
  pencil: PencilIcon,
  copy: CopyIcon,
  folder: FolderIcon,
  "git-branch": GitBranchIcon,
  hash: HashIcon,
  keyboard: KeyboardIcon,
  "mail-open": MailOpenIcon,
  "message-square-plus": MessageSquarePlusIcon,
  pin: PinIcon,
  "pin-off": PinOffIcon,
  "refresh-cw": RefreshCwIcon,
  settings: SettingsIcon,
  "user-plus": UserPlusIcon,
  "folder-tree": FolderTreeIcon,
  trash: Trash2Icon,
};

const menuAttributes = { [FORK_CONTEXT_MENU_ATTRIBUTE]: "" };

/** A header starts a group that runs to the next header; group labels need a group. */
function groupByHeader(items: readonly ContextMenuItem[]): ContextMenuItem[][] {
  const groups: ContextMenuItem[][] = [];
  for (const item of items) {
    const current = groups.at(-1);
    if (item.header === true || current === undefined) groups.push([item]);
    else current.push(item);
  }
  return groups;
}

function ItemIcon({ name }: { name: string | undefined }) {
  const Icon = name === undefined ? undefined : ICONS[name];
  return Icon ? <Icon /> : null;
}

// The item's own menu replaces this menu, as a second open menu would close the first.
const showInPlace = (items: readonly ContextMenuItem[], position: { x: number; y: number }) =>
  requestForkContextMenu(items, position) ?? Promise.resolve(null);

/** Opens the item menu of the focused item from Shift+F10 or the context menu key. */
function itemMenuKeyHandler(command: KeybindingCommand | undefined) {
  if (command === undefined) return {};
  return {
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!isItemMenuKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      void openItemMenu(command, { element: event.currentTarget }, showInPlace);
    },
  };
}

const ITEM_ATTRIBUTE = "data-keybinding-item";

/**
 * Disabled items ignore the pointer, so the popup finds the item under it. A disabled item keeps
 * its menu, because a key for the action is useful before the action is.
 */
function onPopupContextMenu(items: readonly ContextMenuItem[]) {
  return (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    // React passes the event through the submenu portal to the parent popup, which would match
    // its own item under the pointer.
    event.stopPropagation();
    const target = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(`[${ITEM_ATTRIBUTE}]`),
    ].find((element) => {
      const rect = element.getBoundingClientRect();
      return (
        event.clientX >= rect.left &&
        event.clientX < rect.right &&
        event.clientY >= rect.top &&
        event.clientY < rect.bottom
      );
    });
    const command = items.find(
      (item) => item.id === target?.getAttribute(ITEM_ATTRIBUTE),
    )?.keybindingCommand;
    if (command === undefined) return;
    event.stopPropagation();
    void openItemMenu(command, { position: { x: event.clientX, y: event.clientY } }, showInPlace);
  };
}

function itemMenuProps(item: ContextMenuItem) {
  if (item.keybindingCommand === undefined) return {};
  return { [ITEM_ATTRIBUTE]: item.id, ...itemMenuKeyHandler(item.keybindingCommand) };
}

function MenuEntries({
  items,
  onPick,
}: {
  items: readonly ContextMenuItem[];
  onPick: (id: string) => void;
}) {
  return groupByHeader(items).map((group, groupIndex) => (
    <MenuGroup key={group[0]?.id ?? groupIndex}>
      {group.map((item, index) => (
        <MenuEntry
          key={item.id}
          item={item}
          separator={item.separatorBefore === true && (groupIndex > 0 || index > 0)}
          onPick={onPick}
        />
      ))}
    </MenuGroup>
  ));
}

function MenuEntry({
  item,
  separator,
  onPick,
}: {
  item: ContextMenuItem;
  separator: boolean;
  onPick: (id: string) => void;
}) {
  const entry = (() => {
    if (item.header === true) return <MenuGroupLabel>{item.label}</MenuGroupLabel>;
    if (item.children !== undefined) {
      return (
        <MenuSub>
          <MenuSubTrigger disabled={item.disabled} {...itemMenuProps(item)}>
            <ItemIcon name={item.icon} />
            {item.keybindingCommand ? (
              <>
                {/* The label takes the free space, so the hint and the chevron stay at the end. */}
                <span className="flex-1">{item.label}</span>
                <span className="ps-3">
                  <ShortcutHint command={item.keybindingCommand} />
                </span>
              </>
            ) : (
              item.label
            )}
          </MenuSubTrigger>
          <MenuSubPopup
            {...menuAttributes}
            layer="context"
            onContextMenu={onPopupContextMenu(item.children)}
          >
            <MenuEntries items={item.children} onPick={onPick} />
          </MenuSubPopup>
        </MenuSub>
      );
    }
    if (item.checked !== undefined) {
      return (
        <MenuCheckboxItem
          checked={item.checked}
          closeOnClick
          disabled={item.disabled}
          onClick={() => onPick(item.id)}
        >
          {item.label}
        </MenuCheckboxItem>
      );
    }
    return (
      <MenuItem
        disabled={item.disabled}
        variant={item.destructive === true ? "destructive" : "default"}
        onClick={() => onPick(item.id)}
        {...itemMenuProps(item)}
      >
        <ItemIcon name={item.icon} />
        {item.label}
        {item.keybindingCommand ? (
          <span className="ms-auto ps-3">
            <ShortcutHint command={item.keybindingCommand} />
          </span>
        ) : null}
      </MenuItem>
    );
  })();
  return (
    <>
      {separator ? <MenuSeparator /> : null}
      {entry}
    </>
  );
}

/**
 * Fork: draws every `api.contextMenu.show` menu with the app's Base UI menu. Base UI gives
 * keyboard navigation, typeahead, menu roles and edge collision.
 */
export function ForkContextMenuHost() {
  const request = useSyncExternalStore(
    subscribeForkContextMenu,
    readForkContextMenu,
    readForkContextMenu,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this host with the module store while it is mounted
  useEffect(registerForkContextMenuHost, []);

  if (request === null) return null;
  const { key, position } = request;
  return (
    <Menu
      key={key}
      open
      // A modal menu makes the page inert, so focus could not go back before the caller resumes.
      modal={false}
      onOpenChange={(open, details) => {
        // An item press settles with its id in its own click handler.
        if (!open && details.reason !== "item-press") settleForkContextMenu(key, null);
      }}
    >
      {/* Submenus read their keys from the menu tree, which a menu without a trigger lacks. */}
      <MenuTrigger
        {...menuAttributes}
        aria-hidden
        className="pointer-events-none fixed size-0"
        nativeButton={false}
        render={<span />}
        style={{ left: position.x, top: position.y }}
        tabIndex={-1}
      />
      <MenuPopup
        {...menuAttributes}
        align="start"
        side="bottom"
        sideOffset={0}
        finalFocus={false}
        layer="context"
        onContextMenu={onPopupContextMenu(request.items)}
      >
        <MenuEntries items={request.items} onPick={(id) => settleForkContextMenu(key, id)} />
      </MenuPopup>
    </Menu>
  );
}
