import type { ComponentType } from "react";

import { AppToggleShortcutsSettingsRow } from "./AppToggleShortcutsSettingsRow";
import {
  BackForwardButtonsSettingsRow,
  RememberBackForwardHistorySettingsRow,
} from "./BackForwardSettingsRows";
import { EnvironmentLabelSettingsRow } from "./EnvironmentLabelSettingsRow";
import {
  FocusLevelHighlightSettingsRow,
  KeyboardFocusLevelsSettingsRow,
  TooltipShortcutLimitSettingsRow,
  TooltipShortcutsSettingsRow,
} from "./FocusLevelsSettingsRows";
import { ForkChangelogSettingsRow } from "./ForkChangelogSettingsRow";
import {
  AgentSessionImportSettingsRows,
  AutoSettleWaitsForBackgroundCommandsSettingsRow,
  BackgroundWorkDetailsSettingsRow,
  MessagePinsSettingsRow,
  CheckNewerBeforeUpdateInstallSettingsRow,
  CurrentProjectTerminalOpensThreadSettingsRow,
  ForkAutoUpdateSettingsRow,
  RestartReconnectWarningGraceSettingsRow,
  SettingsFindSettingsRow,
  TerminalAppShortcutsFirstSettingsRow,
  TerminalCloseConfirmationSettingsRow,
} from "./ForkSettingsRows";
import { RestoreWorktreesSettingsRow, WorktreeArtifactSettingsRows } from "./ForkWorktreeSettings";
import { GlobalScriptsSettingsRows } from "./GlobalScriptsSettings";
import { InAppNotificationSettingsRows } from "./InAppNotificationSettingsRows";
import { InstalledAppSettingsRow } from "./InstalledAppSettingsRow";
import { KeybindingSyncSettingsRow } from "./KeybindingSyncSettingsRow";
import { MachineMapSettingsRows } from "./MachineMapSettingsRows";
import {
  MobileComposerCameraSettingsRow,
  MobileMessagePinsSettingsRow,
  MobileNewThreadProjectSettingsRow,
  MobilePublishedThemesSettingsRow,
  MobileSidebarTabsSettingsRow,
  MobileWarmRecentChatsSettingsRow,
} from "./MobileAppSettings";
import { PreferOriginRemoteSettingsRow } from "./PreferOriginRemoteSettings";
import { PreviewLocalServerGroupsSettingsRow } from "./PreviewLocalServerGroupsSettingsRow";
import { PullRequestFilterChipsSettingsRow } from "./PullRequestFilterChipsSettingsRow";
import { PullRequestWatchSettingsRows } from "./PullRequestWatchSettings";
import { RecoverInterruptedTurnsSettings } from "./RecoverInterruptedTurnsSettings";
import { RepositoryOwnerFiltersSettingsRow } from "./RepositoryOwnerFiltersSettingsRow";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { SidebarTabsSettingsRow } from "./SidebarTabsSettingsRow";
import { TerminalHistorySettingsRows } from "./TerminalHistorySettingsRows";
import { TerminalKeyMappingsSettingsRow } from "./TerminalKeyMappingsSettingsRow";
import { TerminalThreadFontLimitsSettingsRow } from "./TerminalThreadFontLimitsSettingsRow";
import { TerminalThreadsSettingsRow } from "./TerminalThreadsSettingsRow";
import { ThreadCardLayoutSettingsRows } from "./ThreadCardLayoutSettings";
import {
  MessageLinksSettingsRow,
  ThreadLinkChipsSettingsRow,
  ThreadLinksOpenDesktopAppSettingsRow,
} from "./ThreadLinkChipsSettings";
import { TunnelPairingSettingsRow } from "./TunnelPairingSettingsRow";
import { WebPushSettingsRow } from "./WebPushSettingsRow";
import { WorktreePathTemplateRow } from "./WorktreePathTemplateRow";
import {
  forkSettingPlace,
  forkSettingRowsAt,
  type ForkSettingPlace,
  type ForkSettingRowId,
} from "./forkSettingsCatalog";
import { SettingsSection } from "./settingsLayout";
import type { ResolvedSettingsScope } from "./settingsScope";
import {
  getSettingsSearchTargetScope,
  isSettingsSearchItemOnPlatform,
  isSettingsSearchScopeAvailable,
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchItem,
} from "./settingsSearch";

/**
 * The row component of each fork row. Its slot and the Fork page render the same component, so
 * both places edit the same value. The type requires one for every fork row in the catalog.
 */
export const FORK_SETTING_ROWS: Readonly<Record<ForkSettingRowId, ComponentType>> = {
  "restore-worktrees-on-resume": RestoreWorktreesSettingsRow,
  "auto-settle-waits-for-background-commands": AutoSettleWaitsForBackgroundCommandsSettingsRow,
  "worktree-artifact-eviction": WorktreeArtifactSettingsRows,
  "environment-label-from-machine-map": EnvironmentLabelSettingsRow,
  "tunnel-pairing": TunnelPairingSettingsRow,
  "restart-reconnect-warning-grace": RestartReconnectWarningGraceSettingsRow,
  "in-app-notification-seconds": InAppNotificationSettingsRows,
  "installed-app": InstalledAppSettingsRow,
  "web-push": WebPushSettingsRow,
  "fork-auto-update": ForkAutoUpdateSettingsRow,
  "fork-changelog": ForkChangelogSettingsRow,
  "check-newer-before-update-install": CheckNewerBeforeUpdateInstallSettingsRow,
  "recover-interrupted-turns": RecoverInterruptedTurnsSettings,
  "background-work-details": BackgroundWorkDetailsSettingsRow,
  "message-pins": MessagePinsSettingsRow,
  "prefer-origin-remote": PreferOriginRemoteSettingsRow,
  "pull-request-watch-roles": PullRequestWatchSettingsRows,
  "agent-session-import-window": AgentSessionImportSettingsRows,
  "sidebar-tabs": SidebarTabsSettingsRow,
  "storage-worktree-path-template": WorktreePathTemplateRow,
  "repository-owner-filters": RepositoryOwnerFiltersSettingsRow,
  "pull-request-filter-chips": PullRequestFilterChipsSettingsRow,
  "global-scripts": GlobalScriptsSettingsRows,
  "app-toggle-shortcuts": AppToggleShortcutsSettingsRow,
  "terminal-app-shortcuts-first": TerminalAppShortcutsFirstSettingsRow,
  "keyboard-focus-levels": KeyboardFocusLevelsSettingsRow,
  "focus-level-highlight": FocusLevelHighlightSettingsRow,
  "tooltip-shortcuts": TooltipShortcutsSettingsRow,
  "tooltip-shortcut-limit": TooltipShortcutLimitSettingsRow,
  "settings-find": SettingsFindSettingsRow,
  "terminal-close-confirmation": TerminalCloseConfirmationSettingsRow,
  "thread-card-layout": ThreadCardLayoutSettingsRows,
  "thread-link-chips": ThreadLinkChipsSettingsRow,
  "thread-links-open-desktop-app": ThreadLinksOpenDesktopAppSettingsRow,
  "message-links": MessageLinksSettingsRow,
  "preview-local-server-groups": PreviewLocalServerGroupsSettingsRow,
  "terminal-threads": TerminalThreadsSettingsRow,
  "current-project-terminal-opens-thread": CurrentProjectTerminalOpensThreadSettingsRow,
  "terminal-thread-font-limits": TerminalThreadFontLimitsSettingsRow,
  "terminal-history": TerminalHistorySettingsRows,
  "terminal-key-mappings": TerminalKeyMappingsSettingsRow,
  "machine-map": MachineMapSettingsRows,
  "keybinding-sync": KeybindingSyncSettingsRow,
  "mobile-published-themes": MobilePublishedThemesSettingsRow,
  "mobile-new-thread-project": MobileNewThreadProjectSettingsRow,
  "mobile-composer-camera": MobileComposerCameraSettingsRow,
  "mobile-message-pins": MobileMessagePinsSettingsRow,
  "mobile-sidebar-tabs": MobileSidebarTabsSettingsRow,
  "mobile-warm-recent-chats": MobileWarmRecentChatsSettingsRow,
  "back-forward-buttons": BackForwardButtonsSettingsRow,
  "remember-back-forward-history": RememberBackForwardHistorySettingsRow,
};

/** A section that hides when none of its rows renders, for example a row without an environment. */
export const HIDE_WITHOUT_ROWS = "[&:not(:has([data-slot=settings-row]))]:hidden";

const searchItemsById = new Map<string, SettingsSearchItem>(
  SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item] as const),
);

/**
 * An entry shows where search reaches each of its rows: on this platform and, unless `scopeKind`
 * is null, at the selected scope. The Fork page checks the scope. A slot checks it only where
 * its place hides rows at a project scope; elsewhere a server row locks, like its neighbours.
 */
export function isForkEntryShown(
  ids: ReadonlyArray<string>,
  items: ReadonlyMap<string, SettingsSearchItem>,
  scopeKind: ResolvedSettingsScope["kind"] | null,
): boolean {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return ids.every((id) => {
    const item = items.get(id);
    return (
      item === undefined ||
      (isSettingsSearchItemOnPlatform(item, platform) &&
        (scopeKind === null ||
          isSettingsSearchScopeAvailable(
            getSettingsSearchTargetScope(id)?.scope ?? null,
            scopeKind,
          )))
    );
  });
}

/**
 * Fork: the fork rows of one place in an upstream settings page, from `forkSettingsCatalog.ts`.
 * The upstream page keeps one line per place.
 */
export function ForkSettingsSlot({ place }: { readonly place: ForkSettingPlace }) {
  const definition = forkSettingPlace(place);
  const selectedScopeKind = useOptionalSettingsScope()?.scope.kind ?? "all";
  const scopeKind = definition.hideAtProjectScope === true ? selectedScopeKind : null;
  const rows = forkSettingRowsAt(place)
    .filter((entry) => isForkEntryShown(entry.ids, searchItemsById, scopeKind))
    .map((entry) => {
      const Row = FORK_SETTING_ROWS[entry.ids[0]];
      return <Row key={entry.ids[0]} />;
    });
  if (rows.length === 0) return null;
  if (definition.forkSection !== true || definition.section === null) return rows;
  return (
    <SettingsSection id={`fork-${place}`} title={definition.section} className={HIDE_WITHOUT_ROWS}>
      {rows}
    </SettingsSection>
  );
}
