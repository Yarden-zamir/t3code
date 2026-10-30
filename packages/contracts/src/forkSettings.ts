/**
 * Fork settings. `settings.ts` spreads these fields into the upstream settings schemas, so the
 * upstream file keeps one line per schema and a Fork Sync merge does not conflict with them.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ProjectScript } from "./project.ts";
import { PullRequestAuthorAssociation } from "./pullRequest.ts";
import { SidebarTabs } from "./sidebarTabs.ts";
import { StoredThreadCardLayout, ThreadCardLayouts } from "./slotLayout.ts";

/** Fork: the most pinned messages that one environment keeps. */
export const MESSAGE_PINS_MAX = 200;
/** Fork: the longest message excerpt that a pin keeps. */
export const MESSAGE_PIN_EXCERPT_MAX = 160;

/**
 * Fork: a pinned message. The excerpt and the thread title are copies from the time of the pin,
 * so a list of pins shows them without a load of each thread, also for an archived thread.
 */
export const MessagePin = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  pinnedAt: IsoDateTime,
  excerpt: Schema.String.check(Schema.isMaxLength(MESSAGE_PIN_EXCERPT_MAX)),
  threadTitle: Schema.String,
});
export type MessagePin = typeof MessagePin.Type;

/** Fork: the pinned messages of an environment, by `messagePinKey`. */
export const PinnedMessages = Schema.Record(Schema.String, MessagePin).check(
  Schema.isMaxProperties(MESSAGE_PINS_MAX),
);
export type PinnedMessages = typeof PinnedMessages.Type;

/** Fork: the value of the `sidebarOwnerFilter` client setting. */
export const SidebarOwnerFilter = Schema.Struct({
  operator: Schema.Literals(["is", "is_not"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("is" as const)),
  ),
  owners: Schema.Array(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type SidebarOwnerFilter = typeof SidebarOwnerFilter.Type;
export const MIN_TOOLTIP_SHORTCUT_LIMIT = 1;
export const MAX_TOOLTIP_SHORTCUT_LIMIT = 9;
/** How many keys of one control its tooltip shows before "+N". */
export const TooltipShortcutLimit = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_TOOLTIP_SHORTCUT_LIMIT, maximum: MAX_TOOLTIP_SHORTCUT_LIMIT }),
);

export const MIN_IN_APP_NOTIFICATION_SECONDS = 1;
export const MAX_IN_APP_NOTIFICATION_SECONDS = 300;
/** How long an in-app thread notification stays on screen while the app has focus. */
export const InAppNotificationSeconds = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_IN_APP_NOTIFICATION_SECONDS,
    maximum: MAX_IN_APP_NOTIFICATION_SECONDS,
  }),
);

export const MAX_TERMINAL_KEY_MAPPINGS = 64;
/**
 * Fork: a key that a terminal sends as the bytes in `send`, in place of its own encoding. `key`
 * uses the keybinding syntax, such as `cmd+z`. `send` uses escape notation: `\e`, `\xNN`,
 * `\uNNNN`, `\r`, `\n`, `\t` and `\\`. `\xNN` is the character U+00NN, which the terminal sends
 * as UTF-8, so a value from 0x80 up becomes two bytes. A mapping applies in every terminal.
 */
export const TerminalKeyMapping = Schema.Struct({
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
  send: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
});
export type TerminalKeyMapping = typeof TerminalKeyMapping.Type;

export const MIN_TERMINAL_THREAD_FONT_LIMIT = 6;
export const MAX_TERMINAL_THREAD_FONT_LIMIT = 48;
/** The smallest and largest font size that the zoom keys of a terminal thread reach, in points. */
export const TerminalThreadFontLimit = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_TERMINAL_THREAD_FONT_LIMIT,
    maximum: MAX_TERMINAL_THREAD_FONT_LIMIT,
  }),
);

export const MIN_TERMINAL_HISTORY_LINES = 500;
export const MAX_TERMINAL_HISTORY_LINES = 200_000;
export const TerminalHistoryLines = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_TERMINAL_HISTORY_LINES, maximum: MAX_TERMINAL_HISTORY_LINES }),
);
export const MIN_TERMINAL_HISTORY_MEGABYTES = 1;
export const MAX_TERMINAL_HISTORY_MEGABYTES = 256;
export const TerminalHistoryMegabytes = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_TERMINAL_HISTORY_MEGABYTES,
    maximum: MAX_TERMINAL_HISTORY_MEGABYTES,
  }),
);

export const MIN_AGENT_SESSION_IMPORT_WINDOW_DAYS = 1;
export const MAX_AGENT_SESSION_IMPORT_WINDOW_DAYS = 3650;
/** How far back recent Claude Code and Codex sessions are offered for import. */
export const AgentSessionImportWindowDays = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_AGENT_SESSION_IMPORT_WINDOW_DAYS,
    maximum: MAX_AGENT_SESSION_IMPORT_WINDOW_DAYS,
  }),
);
export type AgentSessionImportWindowDays = typeof AgentSessionImportWindowDays.Type;
const DEFAULT_AGENT_SESSION_IMPORT_WINDOW_DAYS: AgentSessionImportWindowDays = 30;
export const MIN_AGENT_SESSION_IMPORT_MAX_MESSAGES = 1;
// The scanner's 32 MiB selected-history budget still bounds memory above this cap.
export const MAX_AGENT_SESSION_IMPORT_MAX_MESSAGES = 10_000;
/** Newest messages kept per imported session; the first user message is always kept. */
export const AgentSessionImportMaxMessages = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_AGENT_SESSION_IMPORT_MAX_MESSAGES,
    maximum: MAX_AGENT_SESSION_IMPORT_MAX_MESSAGES,
  }),
);
export type AgentSessionImportMaxMessages = typeof AgentSessionImportMaxMessages.Type;
export const DEFAULT_AGENT_SESSION_IMPORT_MAX_MESSAGES: AgentSessionImportMaxMessages = 200;

/**
 * Fork: client access of the machine map (MM-916). `off`: an Access owner gets owner access.
 * `observe`: an approved client key gets its client's arrow, at most `standard`; other keys keep
 * owner access and wait for approval. `enforce` (MM-918): only approved client keys get in, with
 * the full level of their arrow.
 */
export const ClientAccessMode = Schema.Literals(["off", "observe", "enforce"]);
export type ClientAccessMode = typeof ClientAccessMode.Type;

/**
 * Fork: which pull request remarks wake an agent that watches the pull request. With no roles
 * and no logins, a remark wakes the agent unless the server's own account wrote it.
 */
export const PullRequestWatchRemarkFilter = Schema.Struct({
  /**
   * Repository roles whose remarks wake the agent, as the host reports them. A remark from one of
   * these roles or from `authorLogins` wakes the agent; with either list set, the own-account
   * rule does not apply. A remark without a reported role counts only through `authorLogins`.
   */
  authorAssociations: Schema.Array(PullRequestAuthorAssociation).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Logins whose remarks wake the agent whatever their role, compared without case. */
  authorLogins: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Text that marks an agent's remark, such as `<!-- agent -->`. A remark with it never wakes. */
  agentMarker: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type PullRequestWatchRemarkFilter = typeof PullRequestWatchRemarkFilter.Type;

export const ForkClientSettingsFields = {
  confirmTerminalClose: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Fork: a focused terminal hands keys that match an app keybinding to the app first. */
  terminalAppShortcutsFirst: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Fork: global shortcuts that show or hide the desktop app, as Electron accelerators such as
   * `F17`. Plain strings, so one bad entry cannot make the whole settings document unreadable;
   * the desktop app skips an entry that Electron rejects.
   */
  appToggleShortcuts: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Fork: background work status icons open a details popover; their descriptions render markdown links. */
  backgroundWorkDetails: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Fork: pin buttons on messages, and the lists of pins in thread details and the sidebar. */
  messagePins: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Fork: a changelog of fork releases, upstream changes and Fork Sync runs from the update UI. */
  forkChangelogEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Fork: an install of a downloaded desktop update checks for a newer release first, and offers
   * to download that one instead. Unattended installs take the newer release.
   */
  checkNewerBeforeUpdateInstall: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /**
   * Fork: the web app registers a service worker for the installed app (`apps/web/public/sw.js`):
   * an offline page, notifications on Android and iOS, and the badge on the app icon.
   */
  installedAppEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Fork: with the installed app on and system notifications allowed, this browser subscribes to
   * Web Push on each connected server, so thread notifications arrive while the app is closed.
   */
  webPushEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Fork: filter by repository owner (`repositoryOwnerOf`) on the pull request page and in the
   * sidebar. Remove when upstream T3 Code ships its own owner or organization filter.
   */
  repositoryOwnerFilters: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Fork: the active pull request filters show as chips above the list, and an empty list names
   * the filters that emptied it. Remove when upstream T3 Code shows its active filters itself.
   */
  pullRequestFilterChips: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Fork: the sidebar filter by repository owner. "is" shows only the projects of these owners,
   * and "is_not" hides them. Null stands for projects without an owner. No owners shows every
   * project. Applies only while `repositoryOwnerFilters` is on.
   */
  sidebarOwnerFilter: SidebarOwnerFilter.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * Fork: sidebar tabs above the sidebar list, on this device. A thread lives in the tab that the
   * user assigned it to, else in the first tab whose rules match it, else in the default tab. The
   * tabs are the server setting `sidebarTabs`.
   */
  sidebarTabsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Fork: a click on a tab with one thread opens that thread. */
  sidebarTabSingleThreadOpens: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /**
   * Fork: focus levels. Escape moves focus from the composer to the timeline, then to the
   * sidebar. Arrow keys move a cursor in the timeline and the sidebar. Off by default, because
   * these keys change what Escape, arrows, `mod+f` and digits do today.
   */
  keyboardFocusLevels: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Fork: a short outline fade on the screen area that takes focus: composer, timeline, sidebar or right panel. */
  focusLevelHighlight: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Fork: control tooltips show the keys of the control as chips, such as "Stash ⌘S". */
  tooltipShortcuts: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Fork: the most keys one tooltip shows; more show as "+N". */
  tooltipShortcutLimit: TooltipShortcutLimit.pipe(Schema.withDecodingDefault(Effect.succeed(4))),
  /** Fork: the smallest font size that the zoom keys of a terminal thread reach. */
  terminalThreadFontSizeMin: TerminalThreadFontLimit.pipe(
    Schema.withDecodingDefault(Effect.succeed(8)),
  ),
  /** Fork: the largest font size that the zoom keys of a terminal thread reach. */
  terminalThreadFontSizeMax: TerminalThreadFontLimit.pipe(
    Schema.withDecodingDefault(Effect.succeed(24)),
  ),
  /** Fork: keys that every terminal sends as fixed bytes. See `TerminalKeyMapping`. */
  terminalKeyMappings: Schema.Array(TerminalKeyMapping)
    .check(Schema.isMaxLength(MAX_TERMINAL_KEY_MAPPINGS))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * Fork: "New terminal thread in current project" makes the terminal thread at once, like the
   * enlarge button of a terminal draft. Off, because the thread shows before a command runs.
   */
  currentProjectTerminalOpensThread: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /** Fork: back and forward buttons next to the sidebar toggle in the title bar. Off, because it changes the title bar. */
  backForwardButtons: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Fork: the desktop app keeps the back history after a restart, and back and forward skip
   * threads and drafts that no longer exist. Off, because it changes what back does.
   */
  rememberBackForwardHistory: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /**
   * Fork: right after the app starts, the composer waits longer before it warns that a server
   * is reconnecting. Off by default, because it delays an existing warning.
   */
  restartReconnectWarningGrace: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /**
   * Fork: `settings.find` (`mod+f` by default) opens a find box that filters the rows of the open
   * Settings page. Off by default, because it takes `mod+f` from the search of all settings.
   */
  settingsFind: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Fork: how long an in-app thread notification shows. 5 is the toast default. */
  inAppNotificationSeconds: InAppNotificationSeconds.pipe(
    Schema.withDecodingDefault(Effect.succeed(5)),
  ),
  /** Fork: a thread that finishes shows an in-app notification. Off shows only threads that need you. */
  inAppNotificationCompletions: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /**
   * Fork: a notification that asks for input or approval, or tells of a failure, stays until you
   * close it. Off, because it changes how long these notifications show.
   */
  inAppNotificationAttentionStays: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /** Fork: opening a thread closes its in-app notifications. Off, because it changes when they close. */
  inAppNotificationClosesOnOpen: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
};

export const ForkClientSettingsPatchFields = {
  confirmTerminalClose: Schema.optionalKey(Schema.Boolean),
  terminalAppShortcutsFirst: Schema.optionalKey(Schema.Boolean),
  appToggleShortcuts: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  backgroundWorkDetails: Schema.optionalKey(Schema.Boolean),
  messagePins: Schema.optionalKey(Schema.Boolean),
  forkChangelogEnabled: Schema.optionalKey(Schema.Boolean),
  checkNewerBeforeUpdateInstall: Schema.optionalKey(Schema.Boolean),
  installedAppEnabled: Schema.optionalKey(Schema.Boolean),
  webPushEnabled: Schema.optionalKey(Schema.Boolean),
  repositoryOwnerFilters: Schema.optionalKey(Schema.Boolean),
  pullRequestFilterChips: Schema.optionalKey(Schema.Boolean),
  sidebarOwnerFilter: Schema.optionalKey(SidebarOwnerFilter),
  sidebarTabsEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarTabSingleThreadOpens: Schema.optionalKey(Schema.Boolean),
  keyboardFocusLevels: Schema.optionalKey(Schema.Boolean),
  focusLevelHighlight: Schema.optionalKey(Schema.Boolean),
  tooltipShortcuts: Schema.optionalKey(Schema.Boolean),
  tooltipShortcutLimit: Schema.optionalKey(TooltipShortcutLimit),
  terminalThreadFontSizeMin: Schema.optionalKey(TerminalThreadFontLimit),
  terminalThreadFontSizeMax: Schema.optionalKey(TerminalThreadFontLimit),
  terminalKeyMappings: Schema.optionalKey(
    Schema.Array(TerminalKeyMapping).check(Schema.isMaxLength(MAX_TERMINAL_KEY_MAPPINGS)),
  ),
  currentProjectTerminalOpensThread: Schema.optionalKey(Schema.Boolean),
  backForwardButtons: Schema.optionalKey(Schema.Boolean),
  rememberBackForwardHistory: Schema.optionalKey(Schema.Boolean),
  restartReconnectWarningGrace: Schema.optionalKey(Schema.Boolean),
  settingsFind: Schema.optionalKey(Schema.Boolean),
  inAppNotificationSeconds: Schema.optionalKey(InAppNotificationSeconds),
  inAppNotificationCompletions: Schema.optionalKey(Schema.Boolean),
  inAppNotificationAttentionStays: Schema.optionalKey(Schema.Boolean),
  inAppNotificationClosesOnOpen: Schema.optionalKey(Schema.Boolean),
};

/**
 * Fork: what "New thread" opens in the mobile app. `picker` shows the project picker, `last`
 * opens a draft in the project of the last new thread on the phone, and `none` opens a draft
 * without a project. A thread link, a share or a prompt link keeps its own project.
 */
export const MobileNewThreadProject = Schema.Literals(["picker", "last", "none"]);
export type MobileNewThreadProject = typeof MobileNewThreadProject.Type;

export const ForkServerSettingsFields = {
  worktreeArtifactEviction: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeArtifactEvictionDays: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 3650 }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(14))),
  restoreWorktreesOnResume: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Fork: auto-settle skips a thread while a background command of its agent runs. Settling
   * stops the provider session, which kills the command and the wake-up it would send.
   */
  autoSettleWaitsForBackgroundCommands: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /** Fork: use the joined machine map name as the environment label. */
  environmentLabelFromMachineMap: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  /**
   * Fork: where new worktrees go, such as `{repoDir}/{branchLeaf}`. Empty
   * keeps the `worktreesDirectory` layout. See docs/fork/features.md.
   */
  worktreePathTemplate: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Fork: after a restart or crash, send each thread that the restart cut off a
   * recovery message. Unlike `continueThreadsAfterServerUpdate`, this also wakes
   * a thread whose finished turn left background work (native subagents,
   * monitors, background shells) that the restart killed.
   */
  recoverInterruptedTurns: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Fork: the message `recoverInterruptedTurns` sends to a top-level thread. */
  recoverInterruptedTurnsMessage: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("Recover and continue")),
  ),
  /** Fork: the message `recoverInterruptedTurns` sends to a delegated child thread. */
  recoverInterruptedTurnsSubagentMessage: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(
      Effect.succeed("Recover and continue. Your parent thread was also restarted."),
    ),
  ),
  /**
   * Fork: a server that runs as the background service installs each newer
   * fork release when no agent turn runs. See docs/fork/operations.md "Server updates".
   */
  forkAutoUpdate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Scripts available in every project of this environment. They run where a
   * project script runs for the thread: its worktree, else the project root.
   * They live next to project scripts because both run on this host.
   */
  globalScripts: Schema.Array(ProjectScript).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * Pinned script ids in button order. Stored on the server next to the
   * scripts they point at, so every client of this environment shows the
   * same pins and project ids stay environment-local.
   */
  pinnedGlobalScriptIds: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  pinnedProjectScriptIds: Schema.Record(ProjectId, Schema.Array(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Fork: pinned messages. Stored on the server, so every client of this environment shows the
   * same pins. The client setting `messagePins` shows them.
   */
  pinnedMessages: PinnedMessages.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  agentSessionImportWindowDays: AgentSessionImportWindowDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_SESSION_IMPORT_WINDOW_DAYS)),
  ),
  agentSessionImportMaxMessages: AgentSessionImportMaxMessages.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AGENT_SESSION_IMPORT_MAX_MESSAGES)),
  ),
  pullRequestWatchRemarkFilter: PullRequestWatchRemarkFilter.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * Fork: a checkout's repository is its `origin` remote before its `upstream` remote. A fork
   * checkout then lists, reads and watches the pull requests of the fork, not of upstream.
   */
  preferOriginRemote: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Fork: thread links render as the attached-thread chip, and an https thread address of an
   * environment that the client knows opens inside T3. A server setting, so the mobile app reads it.
   */
  threadLinkChips: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Fork: a thread address opened from outside T3 Code in a plain browser tab hands the thread to
   * the desktop app (`t3code://threads/...`) as soon as the page loads.
   */
  threadLinksOpenDesktopApp: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Fork: a thread link with `#<messageId>` opens the thread at that message, scrolls to it and
   * highlights it. Off: the link opens the thread only.
   */
  messageLinks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Fork: user-built thread card layouts. See `ThreadCardLayouts`. */
  threadCardLayouts: ThreadCardLayouts.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * Fork: sidebar tabs and their thread assignments. The machine map syncs the value: a
   * change from the sidebar becomes its shared value (MM-411). Clients show the tabs while the
   * client setting `sidebarTabsEnabled` is on.
   */
  sidebarTabs: SidebarTabs.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * Fork: the machine map reports and applies the rules of `keybindings.json` as the server
   * setting `keybindings` (`KEYBINDINGS_SETTING_KEY`).
   */
  keybindingSync: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Fork: the preview "Local servers" list also shows local listeners that no T3 terminal owns,
   * in groups: same worktree, same project, then all others. A server setting, because this
   * server reads the process folders and sends the HTTP checks, for every client.
   */
  previewLocalServerGroups: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Fork: the mobile app offers the themes that this server publishes, with their fonts, shape
   * and canvas pattern, and takes `defaultTheme`. A server setting, so the machine map syncs it
   * and the mobile app reads it.
   */
  mobilePublishedThemes: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Fork: what "New thread" opens in the mobile app. See `MobileNewThreadProject`. */
  mobileNewThreadProject: MobileNewThreadProject.pipe(
    Schema.withDecodingDefault(Effect.succeed("picker")),
  ),
  /**
   * Fork: the plus button of the mobile composer offers "Take Photo". Off by default, because it
   * turns the plus button into a menu on a server without file attachments.
   */
  mobileComposerCamera: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Fork: the long-press menu of a mobile message offers Pin and Unpin (`pinnedMessages`). A
   * server setting, because the mobile app has no fork client settings.
   */
  mobileMessagePins: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Fork: the home thread list of the mobile app shows the `sidebarTabs` tabs. */
  mobileSidebarTabs: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Fork: after the thread list syncs, the mobile app loads recent threads into its message
   * cache (`forkCacheWarmup.ts`). On by default: it only adds speed, at the cost of an open.
   */
  mobileWarmRecentChats: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Fork: terminal threads (`forkTerminalThreads.ts`). A thread whose screen is a terminal. A
   * server setting, because the server starts the shell and writes the shell integration.
   */
  terminalThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Fork: how many lines of output the server keeps for each terminal. */
  terminalHistoryLines: TerminalHistoryLines.pipe(Schema.withDecodingDefault(Effect.succeed(5000))),
  /** Fork: how many megabytes of output the server keeps for each terminal. */
  terminalHistoryMegabytes: TerminalHistoryMegabytes.pipe(
    Schema.withDecodingDefault(Effect.succeed(8)),
  ),
};

export const ForkServerSettingsPatchFields = {
  worktreeArtifactEviction: Schema.optionalKey(Schema.Boolean),
  worktreeArtifactEvictionDays: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
  ),
  restoreWorktreesOnResume: Schema.optionalKey(Schema.Boolean),
  autoSettleWaitsForBackgroundCommands: Schema.optionalKey(Schema.Boolean),
  environmentLabelFromMachineMap: Schema.optionalKey(Schema.Boolean),
  worktreePathTemplate: Schema.optionalKey(TrimmedString),
  recoverInterruptedTurns: Schema.optionalKey(Schema.Boolean),
  recoverInterruptedTurnsMessage: Schema.optionalKey(TrimmedNonEmptyString),
  recoverInterruptedTurnsSubagentMessage: Schema.optionalKey(TrimmedNonEmptyString),
  forkAutoUpdate: Schema.optionalKey(Schema.Boolean),
  globalScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  pinnedGlobalScriptIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** Per-project entry replacement: each entry replaces that project's pins and `null` removes them. */
  pinnedProjectScriptIds: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Array(TrimmedNonEmptyString))),
  ),
  /** Per-pin entry replacement: an entry adds that pin and `null` removes it. */
  pinnedMessages: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.NullOr(MessagePin)).check(
      Schema.isMaxProperties(MESSAGE_PINS_MAX),
    ),
  ),
  agentSessionImportWindowDays: Schema.optionalKey(AgentSessionImportWindowDays),
  agentSessionImportMaxMessages: Schema.optionalKey(AgentSessionImportMaxMessages),
  preferOriginRemote: Schema.optionalKey(Schema.Boolean),
  threadLinkChips: Schema.optionalKey(Schema.Boolean),
  threadLinksOpenDesktopApp: Schema.optionalKey(Schema.Boolean),
  messageLinks: Schema.optionalKey(Schema.Boolean),
  keybindingSync: Schema.optionalKey(Schema.Boolean),
  previewLocalServerGroups: Schema.optionalKey(Schema.Boolean),
  mobilePublishedThemes: Schema.optionalKey(Schema.Boolean),
  mobileNewThreadProject: Schema.optionalKey(MobileNewThreadProject),
  mobileComposerCamera: Schema.optionalKey(Schema.Boolean),
  mobileMessagePins: Schema.optionalKey(Schema.Boolean),
  mobileSidebarTabs: Schema.optionalKey(Schema.Boolean),
  mobileWarmRecentChats: Schema.optionalKey(Schema.Boolean),
  terminalThreads: Schema.optionalKey(Schema.Boolean),
  terminalHistoryLines: Schema.optionalKey(TerminalHistoryLines),
  terminalHistoryMegabytes: Schema.optionalKey(TerminalHistoryMegabytes),
  /** Replaces the saved tabs whole: a merge would keep deleted tabs and assignments. */
  sidebarTabs: Schema.optionalKey(SidebarTabs),
  /** Per surface: a patched layout replaces the saved one, and `null` restores the built-in card. */
  threadCardLayouts: Schema.optionalKey(
    Schema.Struct({
      desktop: Schema.optionalKey(Schema.NullOr(StoredThreadCardLayout)),
      mobile: Schema.optionalKey(Schema.NullOr(StoredThreadCardLayout)),
    }),
  ),
  /** Merges per field: a patched field replaces the saved one. */
  pullRequestWatchRemarkFilter: Schema.optionalKey(
    Schema.Struct({
      authorAssociations: Schema.optionalKey(Schema.Array(PullRequestAuthorAssociation)),
      authorLogins: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
      agentMarker: Schema.optionalKey(TrimmedString),
    }),
  ),
};
