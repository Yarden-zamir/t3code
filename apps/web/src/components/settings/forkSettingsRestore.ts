import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import * as Equal from "effect/Equal";

import type { ScopedSettingsPatch } from "./scopedSettings";

/**
 * Fork: the fork settings that Restore defaults resets, with their confirmation labels. Like
 * upstream, it resets preferences and keeps user data and access: `globalScripts`, pin lists,
 * `sidebarTabs`, `threadCardLayouts`, `machineMap`, `clientAccess` and tunnel pairing stay.
 * A new fork preference goes in this list.
 */
const FORK_RESTORED_SETTINGS = [
  ["restoreWorktreesOnResume", "Restore worktrees on resume"],
  ["autoSettleWaitsForBackgroundCommands", "Auto-settle waits for background commands"],
  ["worktreeArtifactEviction", "Evict worktree artifacts"],
  ["worktreeArtifactEvictionDays", "Artifact eviction inactivity days"],
  ["installedAppEnabled", "Installed app"],
  ["inAppNotificationSeconds", "In-app notification time"],
  ["inAppNotificationCompletions", "Notify when a thread finishes"],
  ["inAppNotificationAttentionStays", "Keep notifications that need you"],
  ["inAppNotificationClosesOnOpen", "Close notifications of an opened thread"],
  ["webPushEnabled", "Web Push"],
  ["forkAutoUpdate", "Server auto-update"],
  ["forkChangelogEnabled", "Fork changelog"],
  ["checkNewerBeforeUpdateInstall", "Check for a newer update before install"],
  ["recoverInterruptedTurns", "Recover interrupted agents"],
  ["recoverInterruptedTurnsMessage", "Recover interrupted agents message"],
  ["recoverInterruptedTurnsSubagentMessage", "Recover interrupted subagents message"],
  ["backgroundWorkDetails", "Background work details"],
  ["messagePins", "Message pins"],
  ["preferOriginRemote", "Prefer origin remote"],
  ["threadLinkChips", "Thread link chips"],
  ["threadLinksOpenDesktopApp", "Thread addresses open the desktop app"],
  ["messageLinks", "Message links"],
  ["previewLocalServerGroups", "All local servers in the browser"],
  ["mobilePublishedThemes", "Published themes on mobile"],
  ["mobileNewThreadProject", "New thread on mobile"],
  ["mobileComposerCamera", "Camera on mobile"],
  ["mobileMessagePins", "Message pins on mobile"],
  ["mobileSidebarTabs", "Sidebar tabs on mobile"],
  ["mobileWarmRecentChats", "Warm recent chats on mobile"],
  ["terminalThreads", "Terminal threads"],
  ["terminalHistoryLines", "Terminal history lines"],
  ["terminalHistoryMegabytes", "Terminal history megabytes"],
  ["terminalKeyMappings", "Terminal key mappings"],
  ["terminalThreadFontSizeMin", "Terminal thread smallest font"],
  ["terminalThreadFontSizeMax", "Terminal thread largest font"],
  ["keybindingSync", "Keybinding sync"],
  ["environmentLabelFromMachineMap", "Environment name from kitshn"],
  ["pullRequestWatchRemarkFilter", "Pull request watch remarks"],
  ["agentSessionImportWindowDays", "Session import window"],
  ["agentSessionImportMaxMessages", "Imported messages per session"],
  ["sidebarTabsEnabled", "Sidebar tabs"],
  ["sidebarTabSingleThreadOpens", "Single-thread tabs"],
  ["worktreePathTemplate", "Worktree path template"],
  ["repositoryOwnerFilters", "Repository owner filters"],
  ["pullRequestFilterChips", "Pull request filter chips"],
  ["sidebarOwnerFilter", "Sidebar owner filter"],
  ["appToggleShortcuts", "App toggle shortcuts"],
  ["terminalAppShortcutsFirst", "App shortcuts in terminal"],
  ["currentProjectTerminalOpensThread", "Open terminal in current project as a thread"],
  ["keyboardFocusLevels", "Keyboard focus levels"],
  ["focusLevelHighlight", "Focus highlight"],
  ["tooltipShortcuts", "Shortcuts in tooltips"],
  ["tooltipShortcutLimit", "Keys per tooltip"],
  ["backForwardButtons", "Back and forward buttons"],
  ["rememberBackForwardHistory", "Remember back and forward history"],
  ["confirmTerminalClose", "Terminal close confirmation"],
  ["restartReconnectWarningGrace", "Quiet reconnect after restart"],
  ["settingsFind", "Find in settings"],
] as const satisfies ReadonlyArray<
  readonly [keyof UnifiedSettings & keyof ScopedSettingsPatch, string]
>;

/** Fork: the labels of the fork settings that differ from their defaults. */
export function forkChangedSettingLabels(settings: UnifiedSettings): ReadonlyArray<string> {
  return FORK_RESTORED_SETTINGS.flatMap(([key, label]) =>
    Equal.equals(settings[key], DEFAULT_UNIFIED_SETTINGS[key]) ? [] : [label],
  );
}

type ForkRestoredSettingKey = (typeof FORK_RESTORED_SETTINGS)[number][0];

/**
 * Fork: the patch that Restore defaults applies to the fork settings. Each value is read from
 * `DEFAULT_UNIFIED_SETTINGS` by its own key, so the cast only restores the key-to-value pairing
 * that `Object.fromEntries` drops.
 */
export const FORK_SETTINGS_RESTORE_PATCH = Object.fromEntries(
  FORK_RESTORED_SETTINGS.map(([key]) => [key, DEFAULT_UNIFIED_SETTINGS[key]]),
) as Pick<UnifiedSettings, ForkRestoredSettingKey> satisfies ScopedSettingsPatch;
