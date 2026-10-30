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
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import {
  FORK_CONTEXT_MENU_ATTRIBUTE,
  type ForkContextMenuRequest,
  readForkContextMenu,
  registerForkContextMenuHost,
  settleForkContextMenu,
  subscribeForkContextMenu,
} from "../forkContextMenu";
import {
  ignoreContextMenuAfterKey,
  isItemMenuKey,
  KEYBINDINGS_ITEM_LABEL,
  openKeybindingsFor,
} from "../keybindingsMenu";
import { useMenuItemShortcut } from "./focusLevels/ShortcutHint";
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

type ItemMenuRequest = {
  readonly command: KeybindingCommand;
  readonly item: HTMLElement;
  /** A pointer opens the menu at the pointer, a key at the item with its first entry highlighted. */
  readonly point: { x: number; y: number } | null;
};

type OpenItemMenu = (request: ItemMenuRequest) => void;

const ITEM_ATTRIBUTE = "data-keybinding-item";

/**
 * The item's own menu, nested in the menu of the item, so the menu of the item stays open.
 * Escape closes only this menu and gives focus back to the item.
 */
function ItemMenu({
  request,
  onClose,
  onDone,
}: {
  request: ItemMenuRequest;
  onClose: () => void;
  onDone: () => void;
}) {
  const { point, item } = request;
  const anchor =
    point === null
      ? item
      : { getBoundingClientRect: () => DOMRect.fromRect({ ...point, width: 0, height: 0 }) };
  return (
    <MenuSub
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <MenuPopup
        {...menuAttributes}
        anchor={anchor}
        align="start"
        side={point === null ? "inline-end" : "bottom"}
        sideOffset={0}
        layer="context"
        finalFocus={() => (item.isConnected ? item : false)}
        // Base UI leaves focus in the parent menu, whose Escape would close both menus.
        ref={(element) => {
          if (point !== null) element?.focus({ preventScroll: true });
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <MenuItem
          ref={(element) => {
            // Base UI highlights the item that has focus, so Enter runs it.
            if (point === null) element?.focus({ preventScroll: true });
          }}
          onClick={() => {
            onDone();
            openKeybindingsFor(request.command);
          }}
        >
          <KeyboardIcon />
          {KEYBINDINGS_ITEM_LABEL}
        </MenuItem>
      </MenuPopup>
    </MenuSub>
  );
}

/** The item menu state of one popup: its top-level menu or one submenu. */
function useItemMenu(onDone: () => void) {
  const [request, setRequest] = useState<ItemMenuRequest | null>(null);
  const menu =
    request === null ? null : (
      <ItemMenu
        key={`${request.command}:${request.point?.x}:${request.point?.y}`}
        request={request}
        onClose={() => setRequest(null)}
        onDone={onDone}
      />
    );
  return { open: setRequest, menu };
}

/** Opens the item menu of the focused item from Shift+F10 or the context menu key. */
function itemMenuKeyHandler(command: KeybindingCommand, openItemMenu: OpenItemMenu) {
  return {
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!isItemMenuKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      ignoreContextMenuAfterKey();
      openItemMenu({ command, item: event.currentTarget, point: null });
    },
  };
}

/**
 * Disabled items ignore the pointer, so the popup finds the item under it. A disabled item keeps
 * its menu, because a key for the action is useful before the action is.
 */
function onPopupContextMenu(items: readonly ContextMenuItem[], openItemMenu: OpenItemMenu) {
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
    if (command === undefined || target === undefined) return;
    openItemMenu({ command, item: target, point: { x: event.clientX, y: event.clientY } });
  };
}

function itemMenuProps(item: ContextMenuItem, openItemMenu: OpenItemMenu) {
  if (item.keybindingCommand === undefined) return {};
  return {
    [ITEM_ATTRIBUTE]: item.id,
    ...itemMenuKeyHandler(item.keybindingCommand, openItemMenu),
  };
}

function MenuEntries({
  items,
  onPick,
  openItemMenu,
}: {
  items: readonly ContextMenuItem[];
  onPick: (id: string | null) => void;
  openItemMenu: OpenItemMenu;
}) {
  return groupByHeader(items).map((group, groupIndex) => (
    <MenuGroup key={group[0]?.id ?? groupIndex}>
      {group.map((item, index) => (
        <MenuEntry
          key={item.id}
          item={item}
          separator={item.separatorBefore === true && (groupIndex > 0 || index > 0)}
          onPick={onPick}
          openItemMenu={openItemMenu}
        />
      ))}
    </MenuGroup>
  ));
}

function Submenu({
  item,
  children,
  onPick,
}: {
  item: ContextMenuItem & { children: readonly ContextMenuItem[] };
  children: ReactNode;
  onPick: (id: string | null) => void;
}) {
  const itemMenu = useItemMenu(() => onPick(null));
  return (
    <MenuSub>
      {children}
      <MenuSubPopup
        {...menuAttributes}
        layer="context"
        onContextMenu={onPopupContextMenu(item.children, itemMenu.open)}
      >
        <MenuEntries items={item.children} onPick={onPick} openItemMenu={itemMenu.open} />
        {itemMenu.menu}
      </MenuSubPopup>
    </MenuSub>
  );
}

function MenuEntry({
  item,
  separator,
  onPick,
  openItemMenu,
}: {
  item: ContextMenuItem;
  separator: boolean;
  onPick: (id: string | null) => void;
  openItemMenu: OpenItemMenu;
}) {
  const shortcut = useMenuItemShortcut(item.keybindingCommand);
  const keyProps = {
    ...itemMenuProps(item, openItemMenu),
    "aria-keyshortcuts": shortcut.ariaKeyShortcuts,
  };
  const entry = (() => {
    if (item.header === true) return <MenuGroupLabel>{item.label}</MenuGroupLabel>;
    if (item.children !== undefined) {
      return (
        <Submenu item={{ ...item, children: item.children }} onPick={onPick}>
          <MenuSubTrigger disabled={item.disabled} {...keyProps}>
            <ItemIcon name={item.icon} />
            {shortcut.hint ? (
              <>
                {/* The label takes the free space, so the hint and the chevron stay at the end. */}
                <span className="flex-1">{item.label}</span>
                <span className="ps-3">{shortcut.hint}</span>
              </>
            ) : (
              item.label
            )}
          </MenuSubTrigger>
        </Submenu>
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
        {...keyProps}
      >
        <ItemIcon name={item.icon} />
        {item.label}
        {shortcut.hint ? <span className="ms-auto ps-3">{shortcut.hint}</span> : null}
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
  return <OpenMenu key={request.key} request={request} />;
}

function OpenMenu({ request }: { request: ForkContextMenuRequest }) {
  const { key, position } = request;
  const onPick = (id: string | null) => settleForkContextMenu(key, id);
  const itemMenu = useItemMenu(() => onPick(null));
  return (
    <Menu
      open
      // A modal menu makes the page inert, so focus could not go back before the caller resumes.
      modal={false}
      onOpenChange={(open, details) => {
        // An item press settles with its id in its own click handler.
        if (!open && details.reason !== "item-press") onPick(null);
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
        onContextMenu={onPopupContextMenu(request.items, itemMenu.open)}
      >
        <MenuEntries items={request.items} onPick={onPick} openItemMenu={itemMenu.open} />
        {itemMenu.menu}
      </MenuPopup>
    </Menu>
  );
}
