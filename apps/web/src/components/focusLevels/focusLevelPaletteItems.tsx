import type { ForkKeybindingCommand } from "@t3tools/contracts";
import {
  ArchiveIcon,
  ClockIcon,
  KeyboardIcon,
  LinkIcon,
  type LucideIcon,
  MailOpenIcon,
  MessageSquareTextIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PencilIcon,
  SearchIcon,
  TextCursorInputIcon,
} from "lucide-react";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { type FocusLevel, focusLevel } from "./focusLevels";
import {
  hasRegisteredFocusLevelCommand,
  runRegisteredFocusLevelCommand,
} from "./useFocusLevelShortcuts";

const FOCUS_ITEMS: ReadonlyArray<[ForkKeybindingCommand, FocusLevel, string, LucideIcon]> = [
  ["focus.composer", "composer", "Focus composer", TextCursorInputIcon],
  ["focus.timeline", "timeline", "Focus timeline", MessageSquareTextIcon],
  ["focus.sidebar", "sidebar", "Focus sidebar", PanelLeftIcon],
  ["focus.rightPanel", "rightPanel", "Focus right panel", PanelRightIcon],
];

const THREAD_ITEMS: ReadonlyArray<[ForkKeybindingCommand, string, LucideIcon]> = [
  ["thread.archive", "Archive thread", ArchiveIcon],
  ["thread.snooze", "Snooze or wake thread", ClockIcon],
  ["thread.rename", "Rename thread", PencilIcon],
  ["thread.markUnread", "Mark thread unread", MailOpenIcon],
  ["keyboard.cheatSheet", "Show keyboard shortcuts", KeyboardIcon],
];

/** The palette restores focus as it closes, so a focus move waits until that is done. */
function afterPaletteCloses(run: () => void): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        run();
        resolve();
      }),
    ),
  );
}

/** Fork: command palette items for the focus level commands. */
export function focusLevelPaletteItems(
  iconClassName: string,
  messageLinks = false,
): CommandPaletteActionItem[] {
  return [
    // A Settings page with `settingsFind` on registers the command.
    ...(hasRegisteredFocusLevelCommand("settings.find")
      ? [
          {
            kind: "action" as const,
            value: "action:settings.find",
            searchTerms: ["find", "search", "filter", "settings", "page"],
            title: "Find in settings",
            description: "Filter the rows of this settings page",
            icon: <SearchIcon className={iconClassName} />,
            shortcutCommand: "settings.find" as const,
            run: () =>
              afterPaletteCloses(() => void runRegisteredFocusLevelCommand("settings.find")),
          },
        ]
      : []),
    ...(messageLinks
      ? [
          {
            kind: "action" as const,
            value: "action:timeline.copyMessageLink",
            searchTerms: ["copy", "message", "link", "cursor"],
            title: "Copy message link",
            description: "Copy the message under the timeline cursor",
            icon: <LinkIcon className={iconClassName} />,
            shortcutCommand: "timeline.copyMessageLink" as const,
            run: async () => {
              runRegisteredFocusLevelCommand("timeline.copyMessageLink");
            },
          },
        ]
      : []),
    ...FOCUS_ITEMS.map(([command, level, title, Icon]) => ({
      kind: "action" as const,
      value: `action:${command}`,
      searchTerms: ["focus", "keyboard", "move", title],
      title,
      icon: <Icon className={iconClassName} />,
      shortcutCommand: command,
      run: () => afterPaletteCloses(() => void focusLevel(level)),
    })),
    ...THREAD_ITEMS.map(([command, title, Icon]) => ({
      kind: "action" as const,
      value: `action:${command}`,
      searchTerms: ["thread", title],
      title,
      icon: <Icon className={iconClassName} />,
      shortcutCommand: command,
      run: () => afterPaletteCloses(() => void runRegisteredFocusLevelCommand(command)),
    })),
  ];
}
