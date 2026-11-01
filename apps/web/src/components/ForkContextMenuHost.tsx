import type { ContextMenuItem } from "@t3tools/contracts";
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
import { type MouseEvent, type ReactNode, useEffect, useSyncExternalStore } from "react";

import {
  FORK_CONTEXT_MENU_ATTRIBUTE,
  type ForkContextMenuRequest,
  readForkContextMenu,
  registerForkContextMenuHost,
  settleForkContextMenu,
  subscribeForkContextMenu,
} from "../forkContextMenu";
import {
  bindableElement,
  ignoreContextMenuAfterKey,
  isItemMenuKey,
  KEYBINDING_COMMAND_ATTRIBUTE,
  keybindingsEntries,
  openKeybindingsFor,
} from "../keybindingsMenu";
import { useMenuItemShortcut } from "./focusLevels/ShortcutHint";
import {
  configureMenuItemMenus,
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

// Every app menu item that runs a keybinding command gets "Keybindings…" as its own menu.
configureMenuItemMenus({
  selector: `[${KEYBINDING_COMMAND_ATTRIBUTE}]`,
  find: (target) => {
    const bindable = bindableElement(target);
    return bindable === null
      ? null
      : {
          element: bindable.element,
          entries: keybindingsEntries(bindable.commands).map((entry) => ({
            label: entry.label,
            icon: <KeyboardIcon />,
            run: () => openKeybindingsFor(entry.command),
          })),
        };
  },
  isOpenKey: isItemMenuKey,
  onOpenByKey: ignoreContextMenuAfterKey,
});

/**
 * Disabled items ignore the pointer, so `MenuPopup` finds the bindable item under it. A disabled
 * item keeps its item menu, because a key for the action is useful before the action is.
 */
const preventNativeMenu = (event: MouseEvent<HTMLElement>) => event.preventDefault();

function MenuEntries({
  items,
  onPick,
}: {
  items: readonly ContextMenuItem[];
  onPick: (id: string | null) => void;
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

function Submenu({
  item,
  children,
  onPick,
}: {
  item: ContextMenuItem & { children: readonly ContextMenuItem[] };
  children: ReactNode;
  onPick: (id: string | null) => void;
}) {
  return (
    <MenuSub>
      {children}
      <MenuSubPopup {...menuAttributes} layer="context" onContextMenu={preventNativeMenu}>
        <MenuEntries items={item.children} onPick={onPick} />
      </MenuSubPopup>
    </MenuSub>
  );
}

function MenuEntry({
  item,
  separator,
  onPick,
}: {
  item: ContextMenuItem;
  separator: boolean;
  onPick: (id: string | null) => void;
}) {
  const shortcut = useMenuItemShortcut(item.keybindingCommand);
  const keyProps = shortcut.props;
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
  return (
    <Menu
      open
      // A modal menu makes the page inert, so focus could not go back before the caller resumes.
      modal={false}
      onOpenChange={(open) => {
        // An item press settles with its id in its own click handler first; this settles every
        // other close, such as an item of a nested item menu.
        if (!open) queueMicrotask(() => onPick(null));
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
        onContextMenu={preventNativeMenu}
      >
        <MenuEntries items={request.items} onPick={onPick} />
      </MenuPopup>
    </Menu>
  );
}
