/**
 * Fork settings search items. `settingsSearch.ts` spreads each group at the place of its rows, so
 * search results keep their order and the upstream array keeps one line per group.
 */
import type { SettingsSearchItem, SettingsSearchScope } from "./settingsSearch";

/**
 * The fork releases have one track, nightly, so the desktop app hides the upstream Stable/Nightly
 * switch and its search item. That switch targets upstream npm releases. Revisit if the fork
 * publishes a stable track.
 */
export const SHOWS_DESKTOP_UPDATE_TRACK = false;

export type ForkSettingsPath = "/settings/terminal" | "/settings/machines" | "/settings/fork";

export const SECTION_LABELS: Readonly<Record<ForkSettingsPath, string>> = {
  "/settings/terminal": "Terminal",
  "/settings/machines": "Machines",
  "/settings/fork": "Fork",
};

export const CATEGORY_SCOPES: Readonly<Record<ForkSettingsPath, SettingsSearchScope | null>> = {
  // Client and server settings share the Terminal page, so each row keeps its own scope.
  "/settings/terminal": null,
  "/settings/machines": null,
  // Each row of the Fork page keeps the scope of its place.
  "/settings/fork": null,
};

export const WORKTREE_ITEMS = [
  {
    id: "worktree-artifact-eviction",
    title: "Evict worktree artifacts",
    to: "/settings/worktrees",
    scope: "environment-defaults",
    environmentOnly: true,
    searchTerms: ["storage cleanup disk node_modules caches build dependencies worktrees"],
  },
  {
    id: "worktree-artifact-eviction-days",
    title: "Artifact eviction inactivity days",
    to: "/settings/worktrees",
    scope: "environment-defaults",
    environmentOnly: true,
    searchTerms: ["storage cleanup disk inactive days worktrees"],
  },
  {
    id: "restore-worktrees-on-resume",
    title: "Restore worktrees on resume",
    to: "/settings/worktrees",
    scope: "environment-defaults",
    environmentOnly: true,
    searchTerms: [
      "missing folder restore recreate deleted branch checkout dependencies setup node_modules",
    ],
  },
  {
    id: "storage-worktree-path-template",
    title: "Worktree path template",
    to: "/settings/worktrees",
    scope: "environment-defaults",
    searchTerms: [
      "worktree path template location directory folder branch bare container repository sibling",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const ORGANIZATION_ITEMS = [
  {
    id: "auto-settle-waits-for-background-commands",
    title: "Auto-settle waits for background commands",
    to: "/settings/threads",
    scope: "environment-defaults",
    environmentOnly: true,
    requiresThreadAutoSettlement: true,
    searchTerms: ["settle background command bash wake typecheck test run killed"],
  },
  {
    id: "sidebar-tabs",
    title: "Sidebar tabs",
    to: "/settings/general",
    searchTerms: ["tabs folders groups organize threads drag rules monitors views sidebar"],
  },
  {
    id: "sidebar-tab-single-thread",
    title: "Single-thread tabs",
    to: "/settings/general",
    searchTerms: ["sidebar tab one thread open directly"],
  },
  {
    id: "repository-owner-filters",
    title: "Repository owner filters",
    to: "/settings/general",
    searchTerms: [
      "github organization org owner account filter hide exclude pull requests pr sidebar work personal",
    ],
  },
  {
    id: "pull-request-filter-chips",
    title: "Pull request filter chips",
    to: "/settings/general",
    searchTerms: ["active filters chips exclude negative is not pull requests pr list empty"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const APPEARANCE_ITEMS = [
  {
    id: "thread-card-layout",
    title: "Custom card layout",
    to: "/settings/appearance",
    scope: "environment-defaults",
    searchTerms: ["thread card sidebar compact density rows builder layout mobile branch"],
  },
  {
    id: "thread-link-chips",
    title: "Thread link chips",
    to: "/settings/appearance",
    searchTerms: ["thread link chip chat message url open app machine environment"],
    environmentOnly: true,
  },
  {
    id: "thread-links-open-desktop-app",
    title: "Thread addresses open the desktop app",
    to: "/settings/appearance",
    searchTerms: ["thread link address url browser tab slack github desktop app deep link open"],
    environmentOnly: true,
  },
  {
    id: "message-links",
    title: "Message links",
    to: "/settings/appearance",
    searchTerms: ["message link thread scroll jump highlight anchor fragment"],
    environmentOnly: true,
  },
  {
    id: "mobile-published-themes",
    title: "Published themes on mobile",
    to: "/settings/appearance",
    searchTerms: ["mobile phone android app theme published fonts shape radius canvas pattern"],
    environmentOnly: true,
  },
  {
    id: "mobile-new-thread-project",
    title: "New thread on mobile",
    to: "/settings/appearance",
    searchTerms: ["mobile phone android app new thread project picker last scratch no project"],
    environmentOnly: true,
  },
  {
    id: "mobile-composer-camera",
    title: "Camera on mobile",
    to: "/settings/appearance",
    searchTerms: ["mobile phone android app camera photo take picture composer attachment plus"],
    environmentOnly: true,
  },
  {
    id: "mobile-message-pins",
    title: "Message pins on mobile",
    to: "/settings/appearance",
    searchTerms: ["mobile phone android app pin unpin pinned message long press menu"],
    environmentOnly: true,
  },
  {
    id: "mobile-sidebar-tabs",
    title: "Sidebar tabs on mobile",
    to: "/settings/appearance",
    searchTerms: ["mobile phone android app sidebar tabs groups thread list home"],
    environmentOnly: true,
  },
  {
    id: "mobile-warm-recent-chats",
    title: "Warm recent chats on mobile",
    to: "/settings/appearance",
    searchTerms: ["mobile phone android app cache prefetch preload offline recent chats messages"],
    environmentOnly: true,
  },
  {
    id: "back-forward-buttons",
    title: "Back and forward buttons",
    to: "/settings/appearance",
    searchTerms: ["back forward arrows navigation history title bar vs code"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const GLOBAL_SCRIPTS_ITEMS = [
  {
    id: "global-scripts",
    title: "Global scripts",
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: [
      "scripts commands every project pin pinned buttons background overlay preview global hotkey shortcut accelerator",
    ],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const NOTIFICATION_ITEMS = [
  {
    id: "in-app-notification-seconds",
    title: "In-app notification time",
    to: "/settings/general",
    searchTerms: ["notification toast popup duration seconds how long timeout dismiss"],
  },
  {
    id: "in-app-notification-completions",
    title: "Notify when a thread finishes",
    to: "/settings/general",
    searchTerms: ["notification toast popup completion done finished quiet only attention"],
  },
  {
    id: "in-app-notification-attention-stays",
    title: "Keep notifications that need you",
    to: "/settings/general",
    searchTerms: ["notification toast popup sticky persistent input approval failure stay"],
  },
  {
    id: "in-app-notification-closes-on-open",
    title: "Close notifications of an opened thread",
    to: "/settings/general",
    searchTerms: ["notification toast popup dismiss clear open thread visited"],
  },
  {
    id: "installed-app",
    title: "Installed app",
    to: "/settings/general",
    searchTerms: [
      "install pwa home screen offline service worker badge notifications phone android iphone ios",
    ],
    webOnly: true,
  },
  {
    id: "web-push",
    title: "Web Push",
    to: "/settings/general",
    searchTerms: ["web push notification phone android iphone ios closed app background"],
    webOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const BEHAVIOR_ITEMS = [
  {
    id: "recover-interrupted-turns",
    title: "Recover interrupted agents",
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: [
      "recover continue resume restart crash update quit interrupted agent subagent message background",
    ],
  },
  {
    id: "background-work-details",
    title: "Background work details",
    to: "/settings/general",
    searchTerms: ["monitor background command agent task output file popover markdown links"],
  },
  {
    id: "message-pins",
    title: "Message pins",
    to: "/settings/general",
    searchTerms: ["pin unpin pinned message bookmark save list sidebar thread details"],
  },
  {
    id: "remember-back-forward-history",
    title: "Remember back and forward history",
    to: "/settings/general",
    searchTerms: ["back forward navigation history restart restore skip deleted threads"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const AGENT_SESSION_IMPORT_ITEMS = [
  {
    id: "agent-session-import-window",
    title: "Session import window",
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: ["import claude code codex history days recent sessions"],
  },
  {
    id: "agent-session-import-max-messages",
    title: "Imported messages per session",
    to: "/settings/threads",
    scope: "environment-defaults",
    searchTerms: ["import claude code codex history message limit transcript"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const KEYBOARD_ITEMS = [
  {
    id: "settings-find",
    title: "Find in settings",
    to: "/settings/keybindings",
    searchTerms: ["find search filter settings page cmd ctrl f shortcut"],
  },
  {
    id: "keyboard-focus-levels",
    title: "Keyboard focus levels",
    to: "/settings/keybindings",
    searchTerms: ["keyboard escape arrows focus composer timeline sidebar cursor cite tabs"],
  },
  {
    id: "focus-level-highlight",
    title: "Focus highlight",
    to: "/settings/keybindings",
    searchTerms: ["keyboard focus outline flash escape composer timeline sidebar right panel"],
  },
  {
    id: "tooltip-shortcuts",
    title: "Shortcuts in tooltips",
    to: "/settings/keybindings",
    searchTerms: ["keyboard shortcuts keybindings tooltip menu command palette hint key label"],
  },
  {
    id: "tooltip-shortcut-limit",
    title: "Keys per tooltip",
    to: "/settings/keybindings",
    searchTerms: ["keyboard shortcuts keybindings tooltip chips limit more how many"],
  },
  {
    id: "app-toggle-shortcuts",
    title: "App toggle shortcuts",
    to: "/settings/keybindings",
    searchTerms: ["global hotkey keyboard shortcut show hide toggle window raycast f17"],
    desktopOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const ABOUT_ITEMS = [
  {
    id: "fork-changelog",
    title: "Fork changelog",
    to: "/settings/about",
    searchTerms: ["changelog release notes versions upstream fork sync workflow"],
  },
  {
    id: "check-newer-before-update-install",
    title: "Check for a newer update before install",
    to: "/settings/about",
    searchTerms: ["desktop update install newer release download restart"],
  },
  {
    id: "fork-auto-update",
    title: "Server auto-update",
    to: "/settings/maintenance",
    scope: "environment-defaults",
    searchTerms: ["fork release install update idle background service headless server automatic"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const PULL_REQUEST_ITEMS = [
  {
    id: "prefer-origin-remote",
    title: "Pull requests from origin",
    to: "/settings/source-control",
    searchTerms: ["fork origin upstream remote repository pull request pr list"],
    environmentOnly: true,
  },
  {
    id: "pull-request-watch-roles",
    title: "Roles that wake agents",
    to: "/settings/source-control",
    searchTerms: [
      "pull request pr watch remark comment review wake agent owner member collaborator author association role",
    ],
    environmentOnly: true,
  },
  {
    id: "pull-request-watch-logins",
    title: "Logins that wake agents",
    to: "/settings/source-control",
    searchTerms: ["pull request pr watch remark comment review wake agent github user author"],
    environmentOnly: true,
  },
  {
    id: "pull-request-watch-agent-marker",
    title: "Agent remark marker",
    to: "/settings/source-control",
    searchTerms: ["pull request pr watch remark comment wake agent bot skip ignore html comment"],
    environmentOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const CONNECTIONS_ITEMS = [
  {
    id: "tunnel-pairing",
    title: "Allow pairing through a tunnel",
    to: "/settings/access",
    searchTerms: [
      "tunnel cloudflared pairing loopback trusted browser origins cookies cloudflare access login team domain audience aud emails service token",
    ],
    desktopOnly: true,
    localBackendManagementOnly: true,
  },
  {
    id: "restart-reconnect-warning-grace",
    title: "Quiet reconnect after restart",
    to: "/settings/connections",
    searchTerms: ["reconnecting warning banner composer server offline startup update grace delay"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

// Fork: kitshn (MM-203).
export const MACHINE_MAP_ITEMS = [
  {
    id: "environment-label-from-machine-map",
    title: "Environment name from kitshn",
    to: "/settings/machines",
    searchTerms: ["kitshn machine map environment label name hostname computer"],
    environmentOnly: true,
  },
  {
    id: "machine-map",
    title: "Join machines",
    to: "/settings/machines",
    searchTerms: ["kitshn join machines map access links grants"],
  },
  {
    id: "keybinding-sync",
    title: "Sync keybindings",
    to: "/settings/keybindings",
    searchTerms: ["keybindings shortcuts machine map share sync all environments"],
    environmentOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export const PREVIEW_ITEMS = [
  {
    id: "preview-local-server-groups",
    title: "All local servers in the browser",
    to: "/settings/browser",
    searchTerms: ["preview local servers ports listeners dev server worktree project localhost"],
    environmentOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

/** Settings > Terminal: the drawer terminal and terminal threads. */
export const TERMINAL_ITEMS = [
  {
    id: "terminal-thread-font-limits",
    title: "Terminal zoom limits",
    to: "/settings/terminal",
    searchTerms: ["terminal thread zoom font size smallest largest cmd plus minus"],
  },
  {
    id: "terminal-app-shortcuts-first",
    title: "App shortcuts in terminal",
    to: "/settings/terminal",
    searchTerms: ["terminal keybindings keyboard shortcuts priority shell focus"],
  },
  {
    id: "terminal-close-confirmation",
    title: "Terminal close confirmation",
    to: "/settings/terminal",
    searchTerms: ["ask before terminal close stop process"],
  },
  {
    id: "terminal-key-mappings",
    title: "Terminal key mappings",
    to: "/settings/terminal",
    searchTerms: ["terminal key mapping zle editor shortcut command cmd bytes escape send"],
  },
  {
    id: "terminal-history",
    title: "Terminal history",
    to: "/settings/terminal",
    searchTerms: ["terminal history scrollback lines megabytes output kept log size limit"],
    environmentOnly: true,
  },
  {
    id: "terminal-threads",
    title: "Terminal threads",
    to: "/settings/terminal",
    searchTerms: ["terminal thread shell interactive vim cli new terminal"],
    environmentOnly: true,
  },
  {
    id: "current-project-terminal-opens-thread",
    title: "Open terminal in current project as a thread",
    to: "/settings/terminal",
    searchTerms: ["terminal thread new current project enlarge expand draft at once shift click"],
  },
  {
    // `TerminalShellsSettings` renders this id itself.
    id: "terminal-shells",
    title: "Shells",
    to: "/settings/terminal",
    searchTerms: ["terminal thread shell custom executable arguments bash zsh fish uv python"],
    environmentOnly: true,
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
