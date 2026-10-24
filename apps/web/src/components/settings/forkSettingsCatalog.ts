import type { SettingsPath, SettingsSearchItem, SettingsSearchItemId } from "./settingsSearch";

type ForkSettingPlaceDefinition = {
  readonly to: SettingsPath;
  readonly section: string | null;
  readonly forkSection?: true;
  readonly hideAtProjectScope?: true;
};

/**
 * The places in other settings pages where fork rows render. Each place is one
 * `<ForkSettingsSlot place=... />` hook. `section` names the section of the page, or is null
 * when its heading changes, like the machine name in Connections. A place with `forkSection`
 * renders its own section with that title; the others add rows to an upstream section. A place
 * with `hideAtProjectScope` hides its rows at a project scope, like the upstream rows beside it.
 * Elsewhere a server row stays and locks, through `SettingsRow`.
 */
export const FORK_SETTING_PLACES = {
  "general-global-scripts": {
    to: "/settings/general",
    section: "Global scripts",
    forkSection: true,
  },
  "general-organization": { to: "/settings/general", section: "Organization" },
  "general-notifications": { to: "/settings/general", section: "Behavior" },
  "general-behavior": { to: "/settings/general", section: "Behavior" },
  "general-projects-and-threads": { to: "/settings/general", section: "Projects & threads" },
  "general-about": { to: "/settings/general", section: "About" },
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
    section: "Machine map",
    forkSection: true,
  },
  "integrations-browser": { to: "/settings/integrations", section: "Browser" },
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
  "storage-worktrees": { to: "/settings/storage", section: "Worktrees", hideAtProjectScope: true },
  "connections-local": { to: "/settings/connections", section: null },
  "connections-warnings": {
    to: "/settings/connections",
    section: "Connection warnings",
    forkSection: true,
  },
  "machines-machine-map": { to: "/settings/machines", section: "Machine map" },
  "terminal-all-terminals": { to: "/settings/terminal", section: "All terminals" },
  "terminal-threads": { to: "/settings/terminal", section: "Terminal threads" },
} as const satisfies Record<string, ForkSettingPlaceDefinition>;

export type ForkSettingPlace = keyof typeof FORK_SETTING_PLACES;

export function forkSettingPlace(place: ForkSettingPlace): ForkSettingPlaceDefinition {
  return FORK_SETTING_PLACES[place];
}

/**
 * One setting on the Fork page. `ids` are the search ids of the rows of one row component; the
 * first one is the link to its place. A fork row has a `place`, where its slot renders it. An
 * upstream setting that the fork changed has a `change` note instead: upstream renders its row.
 * A `linkOnly` entry is an upstream row that is not its own component: the page shows its title,
 * the note and a link to it.
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
      { ids: ["tunnel-pairing"], place: "connections-local" },
      { ids: ["restart-reconnect-warning-grace"], place: "connections-warnings" },
    ],
  },
  {
    title: "Machine map",
    entries: [
      { ids: ["machine-map"], place: "machines-machine-map" },
      { ids: ["keybinding-sync"], place: "keybindings-machine-map" },
      { ids: ["environment-label-from-machine-map"], place: "machines-machine-map" },
      { ids: ["access-change-notices"], place: "machines-machine-map" },
    ],
  },
  {
    title: "Updates and releases",
    entries: [
      {
        ids: ["update-track", "app-version"],
        change:
          "Fork: installs fork releases, never downgrades, and offers Install when idle while agents run.",
      },
      { ids: ["fork-auto-update"], place: "general-about" },
      { ids: ["fork-changelog"], place: "general-about" },
      { ids: ["check-newer-before-update-install"], place: "general-about" },
    ],
  },
  {
    title: "Agents",
    entries: [
      { ids: ["recover-interrupted-turns"], place: "general-behavior" },
      {
        ids: ["continue-threads-after-server-update"],
        change:
          "Fork: while Recover interrupted agents is on, cut-off threads continue also when this is off.",
        linkOnly: true,
      },
      { ids: ["background-work-details"], place: "general-behavior" },
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
        place: "general-projects-and-threads",
      },
    ],
  },
  {
    title: "Threads",
    entries: [
      { ids: ["restore-worktrees-on-resume"], place: "storage-worktrees" },
      { ids: ["auto-settle-waits-for-background-commands"], place: "general-organization" },
      {
        ids: ["worktree-artifact-eviction", "worktree-artifact-eviction-days"],
        place: "storage-worktrees",
      },
      { ids: ["sidebar-tabs", "sidebar-tab-single-thread"], place: "general-organization" },
      { ids: ["snooze-quick-options"], place: "general-organization" },
      { ids: ["mobile-new-thread-project"], place: "appearance-mobile-app" },
      { ids: ["mobile-composer-camera"], place: "appearance-mobile-app" },
      { ids: ["mobile-sidebar-tabs"], place: "appearance-mobile-app" },
      { ids: ["storage-worktree-path-template"], place: "storage-worktrees" },
      {
        ids: ["storage-worktrees-location"],
        change: "Fork: a worktree path template, when set, replaces this location.",
      },
    ],
  },
  {
    title: "Filters",
    entries: [
      { ids: ["repository-owner-filters"], place: "general-organization" },
      { ids: ["pull-request-filter-chips"], place: "general-organization" },
    ],
  },
  {
    title: "Scripts and keyboard",
    entries: [
      { ids: ["global-scripts"], place: "general-global-scripts" },
      { ids: ["app-toggle-shortcuts"], place: "keybindings-keyboard" },
      { ids: ["keyboard-focus-levels"], place: "keybindings-keyboard" },
      { ids: ["focus-level-highlight"], place: "keybindings-keyboard" },
      { ids: ["tooltip-shortcuts"], place: "keybindings-keyboard" },
      { ids: ["tooltip-shortcut-limit"], place: "keybindings-keyboard" },
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
      { ids: ["installed-app"], place: "general-notifications" },
      { ids: ["web-push"], place: "general-notifications" },
      { ids: ["thread-card-layout"], place: "appearance-thread-cards" },
      { ids: ["thread-link-chips"], place: "appearance-thread-links" },
      { ids: ["thread-links-open-desktop-app"], place: "appearance-thread-links" },
      { ids: ["message-links"], place: "appearance-thread-links" },
      { ids: ["preview-local-server-groups"], place: "integrations-browser" },
      { ids: ["mobile-published-themes"], place: "appearance-mobile-app" },
      { ids: ["back-forward-buttons"], place: "appearance-interface" },
      { ids: ["remember-back-forward-history"], place: "general-behavior" },
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
