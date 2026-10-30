import { ForkClientSettingsFields, ForkServerSettingsFields } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  FORK_SETTING_PLACES,
  forkSettingGroups,
  forkSettingsSearchItems,
  type ForkSettingPlace,
} from "./forkSettingsCatalog";
import { FORK_SETTINGS_RESTORE_PATCH } from "./forkSettingsRestore";
import {
  isSettingsSearchItemOnPlatform,
  SETTINGS_SEARCH_ITEMS,
  searchSettings,
  type SettingsSearchItem,
  type SettingsSearchItemId,
} from "./settingsSearch";

// Fork: a new fork setting must show in its proper place, on Settings > Fork, in search, and
// reset with Restore defaults. docs/fork/operations.md "Change the fork" names these places.

type ForkSettingKey = keyof typeof ForkClientSettingsFields | keyof typeof ForkServerSettingsFields;

/**
 * The search id of the Fork page row of each fork setting, or the reason that it has no row.
 * A new key fails typecheck here first.
 */
const FORK_PAGE_ROWS: Record<
  ForkSettingKey,
  SettingsSearchItemId | { readonly notListed: string }
> = {
  restoreWorktreesOnResume: "restore-worktrees-on-resume",
  autoSettleWaitsForBackgroundCommands: "auto-settle-waits-for-background-commands",
  worktreeArtifactEviction: "worktree-artifact-eviction",
  worktreeArtifactEvictionDays: "worktree-artifact-eviction-days",
  inAppNotificationSeconds: "in-app-notification-seconds",
  inAppNotificationCompletions: "in-app-notification-completions",
  inAppNotificationAttentionStays: "in-app-notification-attention-stays",
  inAppNotificationClosesOnOpen: "in-app-notification-closes-on-open",
  confirmTerminalClose: "terminal-close-confirmation",
  terminalAppShortcutsFirst: "terminal-app-shortcuts-first",
  currentProjectTerminalOpensThread: "current-project-terminal-opens-thread",
  appToggleShortcuts: "app-toggle-shortcuts",
  backgroundWorkDetails: "background-work-details",
  messagePins: "message-pins",
  forkChangelogEnabled: "fork-changelog",
  checkNewerBeforeUpdateInstall: "check-newer-before-update-install",
  installedAppEnabled: "installed-app",
  webPushEnabled: "web-push",
  repositoryOwnerFilters: "repository-owner-filters",
  pullRequestFilterChips: "pull-request-filter-chips",
  sidebarOwnerFilter: { notListed: "The sidebar owner filter menu sets it." },
  sidebarTabsEnabled: "sidebar-tabs",
  sidebarTabSingleThreadOpens: "sidebar-tab-single-thread",
  keyboardFocusLevels: "keyboard-focus-levels",
  focusLevelHighlight: "focus-level-highlight",
  tooltipShortcuts: "tooltip-shortcuts",
  tooltipShortcutLimit: "tooltip-shortcut-limit",
  backForwardButtons: "back-forward-buttons",
  rememberBackForwardHistory: "remember-back-forward-history",
  restartReconnectWarningGrace: "restart-reconnect-warning-grace",
  settingsFind: "settings-find",
  worktreePathTemplate: "storage-worktree-path-template",
  recoverInterruptedTurns: "recover-interrupted-turns",
  recoverInterruptedTurnsMessage: "recover-interrupted-turns",
  recoverInterruptedTurnsSubagentMessage: "recover-interrupted-turns",
  forkAutoUpdate: "fork-auto-update",
  globalScripts: "global-scripts",
  pinnedGlobalScriptIds: { notListed: "The pin buttons of the scripts set it." },
  pinnedProjectScriptIds: { notListed: "The pin buttons of the scripts set it." },
  pinnedMessages: { notListed: "The pin buttons of messages set it." },
  agentSessionImportWindowDays: "agent-session-import-window",
  agentSessionImportMaxMessages: "agent-session-import-max-messages",
  pullRequestWatchRemarkFilter: "pull-request-watch-roles",
  preferOriginRemote: "prefer-origin-remote",
  threadLinkChips: "thread-link-chips",
  threadLinksOpenDesktopApp: "thread-links-open-desktop-app",
  messageLinks: "message-links",
  threadCardLayouts: "thread-card-layout",
  sidebarTabs: { notListed: "Content that the user builds in the sidebar." },
  keybindingSync: "keybinding-sync",
  environmentLabelFromMachineMap: "environment-label-from-machine-map",
  previewLocalServerGroups: "preview-local-server-groups",
  mobilePublishedThemes: "mobile-published-themes",
  mobileNewThreadProject: "mobile-new-thread-project",
  mobileComposerCamera: "mobile-composer-camera",
  mobileMessagePins: "mobile-message-pins",
  mobileSidebarTabs: "mobile-sidebar-tabs",
  mobileWarmRecentChats: "mobile-warm-recent-chats",
  terminalThreads: "terminal-threads",
  terminalHistoryLines: "terminal-history",
  terminalHistoryMegabytes: "terminal-history",
  terminalKeyMappings: "terminal-key-mappings",
  terminalThreadFontSizeMin: "terminal-thread-font-limits",
  terminalThreadFontSizeMax: "terminal-thread-font-limits",
};

/** The settings that Restore defaults keeps, with the reason. */
const KEPT_BY_RESTORE: Partial<Record<ForkSettingKey, string>> = {
  globalScripts: "User data, like project scripts.",
  pinnedGlobalScriptIds: "User data, like project scripts.",
  pinnedProjectScriptIds: "User data, like project scripts.",
  pinnedMessages: "User data, like project scripts.",
  sidebarTabs: "Content that the user built, like keybindings.",
  threadCardLayouts: "Content that the user built, like keybindings.",
};

const forkSettingKeys = [
  ...Object.keys(ForkClientSettingsFields),
  ...Object.keys(ForkServerSettingsFields),
] as ReadonlyArray<ForkSettingKey>;

describe("fork settings registration", () => {
  it("lists each fork setting on Settings > Fork", () => {
    const catalogIds = new Set<string>(
      forkSettingGroups.flatMap((group) => group.entries.flatMap((entry) => entry.ids)),
    );
    const missing = forkSettingKeys.flatMap((key) => {
      const row = FORK_PAGE_ROWS[key];
      if (row === undefined) {
        return [
          `${key}: add it to FORK_PAGE_ROWS in apps/web/src/components/settings/forkSettingsRegistration.test.ts`,
        ];
      }
      if (typeof row !== "string" || catalogIds.has(row)) return [];
      return [
        `${key}: add "${row}" to FORK_SETTING_GROUPS in apps/web/src/components/settings/forkSettingsCatalog.ts`,
      ];
    });
    expect(missing).toEqual([]);
  });

  it("puts each terminal setting on Settings > Terminal", () => {
    const misplaced = forkSettingKeys.flatMap((key) => {
      const row = FORK_PAGE_ROWS[key];
      if (typeof row !== "string" || !key.toLowerCase().includes("terminal")) return [];
      const item = SETTINGS_SEARCH_ITEMS.find((candidate) => candidate.id === row);
      return item?.to === "/settings/terminal" ? [] : [`${key}: ${row} leads to ${item?.to}`];
    });
    expect(misplaced).toEqual([]);
  });

  it("resets or deliberately keeps each fork setting on Restore defaults", () => {
    const missing = forkSettingKeys
      .filter((key) => !(key in FORK_SETTINGS_RESTORE_PATCH) && KEPT_BY_RESTORE[key] === undefined)
      .map(
        (key) =>
          `${key}: add it to FORK_RESTORED_SETTINGS in apps/web/src/components/settings/forkSettingsRestore.ts`,
      );
    expect(missing).toEqual([]);
  });

  it("gives each fork setting one place outside the Fork page, where its search result opens", () => {
    const entries = forkSettingGroups.flatMap((group) => group.entries);
    const problems = forkSettingKeys.flatMap((key) => {
      const row = FORK_PAGE_ROWS[key];
      if (typeof row !== "string") return [];
      const owners = entries.filter((entry) => (entry.ids as ReadonlyArray<string>).includes(row));
      if (owners.length !== 1) return [`${key}: "${row}" is in ${owners.length} catalog entries`];
      const [entry] = owners;
      if (entry === undefined || !("place" in entry)) return [`${key}: its entry has no place`];
      const place = FORK_SETTING_PLACES[entry.place];
      if ((place.to as string) === "/settings/fork") return [`${key}: its place is the Fork page`];
      return entry.ids.flatMap((id) => {
        const item = searchItem(id);
        return item.to === place.to
          ? []
          : [`${key}: search opens "${id}" on ${item.to}, but its place is on ${place.to}`];
      });
    });
    expect(problems).toEqual([]);
  });

  // A Fork page entry shows only while each of its ids is on the platform.
  it("hides no catalog entry by an id that the platform hides", () => {
    const hidden = forkSettingGroups.flatMap((group) =>
      group.entries.flatMap((entry) => {
        const shown = entry.ids.map((id) => isSettingsSearchItemOnPlatform(searchItem(id), ""));
        return shown.includes(true) && shown.includes(false) ? [entry.ids.join(", ")] : [];
      }),
    );
    expect(hidden).toEqual([]);
  });

  it("renders each place from exactly one slot", () => {
    const sources = Object.values(
      import.meta.glob<string>(["../**/*.tsx", "!../**/*.test.tsx"], {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    );
    const counts = (Object.keys(FORK_SETTING_PLACES) as ForkSettingPlace[]).map((place) => [
      place,
      sources.reduce((count, source) => count + source.split(`place="${place}"`).length - 1, 0),
    ]);
    expect(counts.filter(([, count]) => count !== 1)).toEqual([]);
  });

  it("finds each fork row in search at its place and on the Fork page", () => {
    const items = [...SETTINGS_SEARCH_ITEMS, ...forkSettingsSearchItems(SETTINGS_SEARCH_ITEMS)];
    const missing = forkSettingGroups.flatMap((group) =>
      group.entries.flatMap((entry) =>
        "place" in entry
          ? entry.ids.flatMap((id) => {
              const item = searchItem(id);
              // Tests run outside the desktop app, where search drops desktop-only rows.
              if (!isSettingsSearchItemOnPlatform(item, "")) return [];
              const results = searchSettings(item.title, items);
              const found =
                results.some(
                  (result) => result.id === id && result.to === FORK_SETTING_PLACES[entry.place].to,
                ) &&
                results.some(
                  (result) => result.id === `fork-${id}` && result.to === "/settings/fork",
                );
              return found ? [] : [id];
            })
          : [],
      ),
    );
    expect(missing).toEqual([]);
  });
});

function searchItem(id: string): SettingsSearchItem {
  const item = (SETTINGS_SEARCH_ITEMS as ReadonlyArray<SettingsSearchItem>).find(
    (candidate) => candidate.id === id,
  );
  if (item === undefined) throw new Error(`No settings search item "${id}".`);
  return item;
}
