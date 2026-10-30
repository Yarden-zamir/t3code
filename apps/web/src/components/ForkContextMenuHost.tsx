import { useAtomValue } from "@effect/atom-react";
import type { ClientSettings, ContextMenuItem, KeybindingCommand } from "@t3tools/contracts";
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
import { useEffect, useSyncExternalStore } from "react";

import {
  FORK_CONTEXT_MENU_ATTRIBUTE,
  readForkContextMenu,
  registerForkContextMenuHost,
  settleForkContextMenu,
  subscribeForkContextMenu,
} from "../forkContextMenu";
import { useClientSettings } from "../hooks/useSettings";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
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
const selectEnabled = (settings: ClientSettings) => settings.richContextMenu;

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

function ItemShortcut({ command }: { command: KeybindingCommand }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const label = shortcutLabelForCommand(keybindings, command);
  return label ? <MenuShortcut>{label}</MenuShortcut> : null;
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
          <MenuSubTrigger disabled={item.disabled}>
            <ItemIcon name={item.icon} />
            {item.label}
          </MenuSubTrigger>
          <MenuSubPopup {...menuAttributes} layer="context">
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
      >
        <ItemIcon name={item.icon} />
        {item.label}
        {item.keybindingCommand ? <ItemShortcut command={item.keybindingCommand} /> : null}
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
 * Fork: draws `api.contextMenu.show` menus with the app's Base UI menu while `richContextMenu` is
 * on. Base UI gives keyboard navigation, typeahead, menu roles and edge collision.
 */
export function ForkContextMenuHost() {
  const request = useSyncExternalStore(
    subscribeForkContextMenu,
    readForkContextMenu,
    readForkContextMenu,
  );

  const enabled = useClientSettings(selectEnabled);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this host with the module store while the setting is on
  useEffect(() => (enabled ? registerForkContextMenuHost() : undefined), [enabled]);

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
      >
        <MenuEntries items={request.items} onPick={(id) => settleForkContextMenu(key, id)} />
      </MenuPopup>
    </Menu>
  );
}
