import type { SettingsPath, SettingsSearchItem, SettingsSearchItemId } from "./settingsSearch";

type ForkSettingPlaceDefinition = {
  readonly to: SettingsPath;
  readonly section: string | null;
  readonly forkSection?: true;
  readonly hideAtProjectScope?: true;
};

/**
 * Places in other settings pages where fork rows render, each one `<ForkSettingsSlot place=... />`.
 * `section` names the page section, or is null when its heading changes. `forkSection` renders its
 * own section; others add rows to an upstream section. `hideAtProjectScope` hides rows at project
 * scope like their upstream neighbors; elsewhere a server row locks through `SettingsRow`.
 */
export const FORK_SETTING_PLACES = {
  "general-notifications": { to: "/settings/general", section: "Notifications" },
  "general-in-app-notifications": { to: "/settings/general", section: "Notifications" },
  "general-sidebar": { to: "/settings/general", section: "Sidebar" },
  "general-display": { to: "/settings/general", section: "Display" },
  "threads-new-projects": { to: "/settings/threads", section: "New projects" },
  "threads-global-scripts": {
    to: "/settings/threads",
    section: "Global scripts",
    forkSection: true,
  },
  "threads-auto-settle": { to: "/settings/threads", section: "Auto-settle" },
  "maintenance-updates": { to: "/settings/maintenance", section: "Updates" },
  "about-app": { to: "/settings/about", section: "App" },
  "appearance-interface": { to: "/settings/appearance", section: "Interface" },
  "appearance-thread-cards": {
    to: "/settings/appearance",
    section: "Thread cards",
    forkSection: true,
  },
  "appearance-thread-links": {
    to: "/settings/appearance",
    section: "Thread links",
    forkSection: true,
  },
  "appearance-mobile-app": { to: "/settings/appearance", section: "Mobile app", forkSection: true },
  "keybindings-keyboard": { to: "/settings/keybindings", section: "Keyboard", forkSection: true },
  "keybindings-machine-map": {
    to: "/settings/keybindings",
    section: "kitshn",
    forkSection: true,
  },
  "browser-browsing": { to: "/settings/browser", section: "Browsing" },
  "source-control-fork-checkouts": {
    to: "/settings/source-control",
    section: "Fork checkouts",
    forkSection: true,
  },
  "source-control-pull-request-watch": {
    to: "/settings/source-control",
    section: "Pull request watch",
    forkSection: true,
  },
  "worktrees-creation": {
    to: "/settings/worktrees",
    section: "Creation",
    hideAtProjectScope: true,
  },
  "access-local": { to: "/settings/access", section: null },
  "connections-warnings": {
    to: "/settings/connections",
    section: "Connection warnings",
    forkSection: true,
  },
  "machines-machine-map": { to: "/settings/machines", section: "kitshn" },
  "terminal-all-terminals": { to: "/settings/terminal", section: "All terminals" },
  "terminal-threads": { to: "/settings/terminal", section: "Terminal threads" },
} as const satisfies Record<string, ForkSettingPlaceDefinition>;

export type ForkSettingPlace = keyof typeof FORK_SETTING_PLACES;

export function forkSettingPlace(place: ForkSettingPlace): ForkSettingPlaceDefinition {
  return FORK_SETTING_PLACES[place];
}

/**
 * One setting on the Fork page. `ids` are the search ids of one row component; the first links to
 * its place. A fork row has a `place`, where its slot renders it. An upstream setting that the fork
 * changed has a `change` note instead. A `linkOnly` entry is an upstream row without its own
 * component: the page shows its title, the note and a link.
 */
type ForkSettingEntry =
  | {
      readonly ids: readonly [SettingsSearchItemId, ...SettingsSearchItemId[]];
      readonly place: ForkSettingPlace;
    }
  | {
      readonly ids: readonly [SettingsSearchItemId, ...SettingsSearchItemId[]];
      readonly change: string;
    }
  | {
      readonly ids: readonly [SettingsSearchItemId];
      readonly change: string;
      readonly linkOnly: true;
    };

/**
 * Fork: every fork setting and every upstream setting that the fork changed, in the groups of
 * the README "Fork features" section. Add a new fork setting here with its place, and its row
 * component in `FORK_SETTING_ROWS` (ForkSettingsSlot.tsx). This module imports no components, so
 * the settings search can read it without loading the settings pages.
 */
const FORK_SETTING_GROUPS = [
  {
    title: "Remote access",
    entries: [
      { ids: ["tunnel-pairing"], place: "access-local" },
      { ids: ["restart-reconnect-warning-grace"], place: "connections-warnings" },
    ],
  },
  {
    title: "kitshn",
    entries: [
      { ids: ["machine-map"], place: "machines-machine-map" },
      { ids: ["keybinding-sync"], place: "keybindings-machine-map" },
      { ids: ["environment-label-from-machine-map"], place: "machines-machine-map" },
    ],
  },
  {
    title: "Updates and releases",
    entries: [
      {
        ids: ["app-version"],
        change:
          "Fork: installs fork releases, never downgrades, and offers Install when idle while agents or terminal programs run.",
      },
      { ids: ["fork-auto-update"], place: "maintenance-updates" },
      { ids: ["fork-changelog"], place: "about-app" },
      { ids: ["check-newer-before-update-install"], place: "about-app" },
    ],
  },
  {
    title: "Agents",
    entries: [
      { ids: ["recover-interrupted-turns"], place: "maintenance-updates" },
      {
        ids: ["continue-threads-after-server-update"],
        change:
          "Fork: while Recover interrupted agents is on, cut-off threads continue also when this is off.",
        linkOnly: true,
      },
      { ids: ["background-work-details"], place: "general-display" },
      { ids: ["prefer-origin-remote"], place: "source-control-fork-checkouts" },
      {
        ids: [
          "pull-request-watch-roles",
          "pull-request-watch-logins",
          "pull-request-watch-agent-marker",
        ],
        place: "source-control-pull-request-watch",
      },
      {
        ids: ["agent-session-import-window", "agent-session-import-max-messages"],
        place: "threads-new-projects",
      },
    ],
  },
  {
    title: "Threads",
    entries: [
      { ids: ["restore-worktrees-on-resume"], place: "worktrees-creation" },
      { ids: ["auto-settle-waits-for-background-commands"], place: "threads-auto-settle" },
      {
        ids: ["worktree-artifact-eviction", "worktree-artifact-eviction-days"],
        place: "worktrees-creation",
      },
      { ids: ["sidebar-tabs", "sidebar-tab-single-thread"], place: "general-sidebar" },
      { ids: ["message-pins"], place: "general-display" },
      { ids: ["mobile-new-thread-project"], place: "appearance-mobile-app" },
      { ids: ["mobile-composer-camera"], place: "appearance-mobile-app" },
      { ids: ["mobile-message-pins"], place: "appearance-mobile-app" },
      { ids: ["mobile-sidebar-tabs"], place: "appearance-mobile-app" },
      { ids: ["mobile-warm-recent-chats"], place: "appearance-mobile-app" },
      { ids: ["storage-worktree-path-template"], place: "worktrees-creation" },
      {
        ids: ["storage-worktrees-location"],
        change: "Fork: a worktree path template, when set, replaces this location.",
      },
    ],
  },
  {
    title: "Filters",
    entries: [
      { ids: ["repository-owner-filters"], place: "general-sidebar" },
      { ids: ["pull-request-filter-chips"], place: "general-sidebar" },
    ],
  },
  {
    title: "Scripts and keyboard",
    entries: [
      { ids: ["global-scripts"], place: "threads-global-scripts" },
      { ids: ["app-toggle-shortcuts"], place: "keybindings-keyboard" },
      { ids: ["keyboard-focus-levels"], place: "keybindings-keyboard" },
      { ids: ["focus-level-highlight"], place: "keybindings-keyboard" },
      { ids: ["tooltip-shortcuts"], place: "keybindings-keyboard" },
      { ids: ["tooltip-shortcut-limit"], place: "keybindings-keyboard" },
      { ids: ["settings-find"], place: "keybindings-keyboard" },
    ],
  },
  {
    title: "Terminal",
    entries: [
      { ids: ["terminal-thread-font-limits"], place: "terminal-all-terminals" },
      { ids: ["terminal-key-mappings"], place: "terminal-all-terminals" },
      { ids: ["terminal-app-shortcuts-first"], place: "terminal-all-terminals" },
      { ids: ["terminal-close-confirmation"], place: "terminal-all-terminals" },
      { ids: ["terminal-history"], place: "terminal-all-terminals" },
      { ids: ["terminal-threads"], place: "terminal-threads" },
      { ids: ["current-project-terminal-opens-thread"], place: "terminal-threads" },
    ],
  },
  {
    title: "Web app and look",
    entries: [
      {
        ids: [
          "in-app-notification-seconds",
          "in-app-notification-completions",
          "in-app-notification-attention-stays",
          "in-app-notification-closes-on-open",
        ],
        place: "general-in-app-notifications",
      },
      { ids: ["installed-app"], place: "general-notifications" },
      { ids: ["web-push"], place: "general-notifications" },
      { ids: ["thread-card-layout"], place: "appearance-thread-cards" },
      { ids: ["thread-link-chips"], place: "appearance-thread-links" },
      { ids: ["thread-links-open-desktop-app"], place: "appearance-thread-links" },
      { ids: ["message-links"], place: "appearance-thread-links" },
      { ids: ["preview-local-server-groups"], place: "browser-browsing" },
      { ids: ["mobile-published-themes"], place: "appearance-mobile-app" },
      { ids: ["back-forward-buttons"], place: "appearance-interface" },
      { ids: ["remember-back-forward-history"], place: "general-display" },
    ],
  },
] as const satisfies ReadonlyArray<{
  readonly title: string;
  readonly entries: ReadonlyArray<ForkSettingEntry>;
}>;

type ForkSettingCatalogEntry = (typeof FORK_SETTING_GROUPS)[number]["entries"][number];

/** A fork row: an entry that a slot renders at its place. */
export type ForkSettingRowEntry = Extract<ForkSettingCatalogEntry, { readonly place: string }>;

/** The first search id of each fork row. */
export type ForkSettingRowId = ForkSettingRowEntry["ids"][0];

/** The first search id of each upstream row that the Fork page renders. */
export type UpstreamSettingRowId = Exclude<
  ForkSettingCatalogEntry,
  { readonly place: string } | { readonly linkOnly: true }
>["ids"][0];

export const forkSettingGroups: ReadonlyArray<{
  readonly title: string;
  readonly entries: ReadonlyArray<ForkSettingCatalogEntry>;
}> = FORK_SETTING_GROUPS;

/** The fork rows of one place, in catalog order. */
export function forkSettingRowsAt(place: ForkSettingPlace): ReadonlyArray<ForkSettingRowEntry> {
  return forkSettingGroups.flatMap((group) =>
    group.entries.filter(
      (entry): entry is ForkSettingRowEntry => "place" in entry && entry.place === place,
    ),
  );
}

/**
 * Search results for the rows of the Fork page. Each one copies the result of its place,
 * so it has the same scope and availability, and sorts after it.
 */
export function forkSettingsSearchItems(
  available: ReadonlyArray<SettingsSearchItem>,
): ReadonlyArray<SettingsSearchItem> {
  const availableById = new Map(available.map((item) => [item.id, item] as const));
  return forkSettingGroups.flatMap((group) =>
    group.entries.flatMap((entry) =>
      entry.ids.flatMap((id) => {
        const item = availableById.get(id);
        if (item === undefined) return [];
        return [
          {
            ...item,
            id: `fork-${item.id}`,
            targetId: item.id,
            to: "/settings/fork" as const,
            secondary: true,
          },
        ];
      }),
    ),
  );
}
