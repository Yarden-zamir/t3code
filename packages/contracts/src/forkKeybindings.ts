/**
 * Fork: keybinding commands for focus levels, the sidebar and timeline cursors, thread actions
 * and approvals. `keybindings.ts` spreads them into the upstream command list.
 */

export const SIDEBAR_TAB_JUMP_KEYBINDING_COMMANDS = [
  "sidebar.tab.1",
  "sidebar.tab.2",
  "sidebar.tab.3",
  "sidebar.tab.4",
  "sidebar.tab.5",
  "sidebar.tab.6",
  "sidebar.tab.7",
  "sidebar.tab.8",
  "sidebar.tab.9",
] as const;
export type SidebarTabJumpKeybindingCommand = (typeof SIDEBAR_TAB_JUMP_KEYBINDING_COMMANDS)[number];

export const FORK_KEYBINDING_COMMANDS = [
  "focus.up",
  "focus.left",
  "focus.right",
  "focus.composer",
  "focus.timeline",
  "focus.sidebar",
  "focus.rightPanel",
  "sidebar.previousItem",
  "sidebar.nextItem",
  "sidebar.openItem",
  "sidebar.previousTab",
  "sidebar.nextTab",
  "sidebar.search",
  ...SIDEBAR_TAB_JUMP_KEYBINDING_COMMANDS,
  "timeline.previous",
  "timeline.next",
  "timeline.deeper",
  "timeline.shallower",
  "timeline.extendUp",
  "timeline.extendDown",
  "timeline.cite",
  "timeline.citeWithNote",
  "timeline.copyMessageLink",
  "timeline.jumpToLatest",
  "thread.archive",
  "thread.snooze",
  "thread.rename",
  "thread.markUnread",
  "approval.approve",
  "approval.alwaysAllow",
  "approval.decline",
  "rightPanel.previousTab",
  "rightPanel.nextTab",
  "settings.open",
  "keyboard.cheatSheet",
] as const;
export type ForkKeybindingCommand = (typeof FORK_KEYBINDING_COMMANDS)[number];
