import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_AGENT_SESSION_IMPORT_MAX_MESSAGES,
  MAX_AGENT_SESSION_IMPORT_WINDOW_DAYS,
  MIN_AGENT_SESSION_IMPORT_MAX_MESSAGES,
  MIN_AGENT_SESSION_IMPORT_WINDOW_DAYS,
} from "@t3tools/contracts/settings";

import { Switch } from "../ui/switch";
import { BoundedIntegerInput } from "./BoundedIntegerInput";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/**
 * Fork: setting rows that their place and the Fork page both render.
 * Each row edits the same value in both places.
 */

/** Fork: `agentSessionImportWindowDays` and `agentSessionImportMaxMessages`. */
export function AgentSessionImportSettingsRows() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["agentSessionImportWindowDays"]}
        {...searchableSetting("agent-session-import-window")}
        description="Claude Code and Codex sessions active within this many days are offered for import."
        resetAction={
          settings.agentSessionImportWindowDays !==
          DEFAULT_UNIFIED_SETTINGS.agentSessionImportWindowDays ? (
            <SettingResetButton
              label="session import window"
              onClick={() =>
                updateSettings({
                  agentSessionImportWindowDays:
                    DEFAULT_UNIFIED_SETTINGS.agentSessionImportWindowDays,
                })
              }
            />
          ) : null
        }
        control={
          <BoundedIntegerInput
            value={settings.agentSessionImportWindowDays}
            min={MIN_AGENT_SESSION_IMPORT_WINDOW_DAYS}
            max={MAX_AGENT_SESSION_IMPORT_WINDOW_DAYS}
            onCommit={(value) => updateSettings({ agentSessionImportWindowDays: value })}
            aria-label="Days of session history offered for import"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["agentSessionImportMaxMessages"]}
        {...searchableSetting("agent-session-import-max-messages")}
        description="Newest messages kept per imported session. The first prompt is always kept."
        resetAction={
          settings.agentSessionImportMaxMessages !==
          DEFAULT_UNIFIED_SETTINGS.agentSessionImportMaxMessages ? (
            <SettingResetButton
              label="imported messages per session"
              onClick={() =>
                updateSettings({
                  agentSessionImportMaxMessages:
                    DEFAULT_UNIFIED_SETTINGS.agentSessionImportMaxMessages,
                })
              }
            />
          ) : null
        }
        control={
          <BoundedIntegerInput
            value={settings.agentSessionImportMaxMessages}
            min={MIN_AGENT_SESSION_IMPORT_MAX_MESSAGES}
            max={MAX_AGENT_SESSION_IMPORT_MAX_MESSAGES}
            onCommit={(value) => updateSettings({ agentSessionImportMaxMessages: value })}
            aria-label="Messages kept per imported session"
          />
        }
      />
    </>
  );
}

/** Fork: `settingsFind`. */
export function SettingsFindSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("settings-find")}
      description="On a Settings page, Find in settings (⌘F or Ctrl+F by default) opens a box that hides the rows of that page that do not match. The search of all settings keeps /. Off: ⌘F goes to the search of all settings."
      resetAction={
        settings.settingsFind !== DEFAULT_UNIFIED_SETTINGS.settingsFind ? (
          <SettingResetButton
            label="find in settings"
            onClick={() => updateSettings({ settingsFind: DEFAULT_UNIFIED_SETTINGS.settingsFind })}
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.settingsFind}
          onCheckedChange={(checked) => updateSettings({ settingsFind: Boolean(checked) })}
          aria-label="Find in settings"
        />
      }
    />
  );
}

/** Fork: `confirmTerminalClose`. */
export function TerminalCloseConfirmationSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("terminal-close-confirmation")}
      description="Ask before closing a terminal and stopping its process."
      resetAction={
        settings.confirmTerminalClose !== DEFAULT_UNIFIED_SETTINGS.confirmTerminalClose ? (
          <SettingResetButton
            label="terminal close confirmation"
            onClick={() =>
              updateSettings({
                confirmTerminalClose: DEFAULT_UNIFIED_SETTINGS.confirmTerminalClose,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.confirmTerminalClose}
          onCheckedChange={(checked) => updateSettings({ confirmTerminalClose: Boolean(checked) })}
          aria-label="Confirm terminal close"
        />
      }
    />
  );
}

/** Fork: `terminalAppShortcutsFirst`. */
export function TerminalAppShortcutsFirstSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("terminal-app-shortcuts-first")}
      description="When the terminal has focus, keys that match an app keybinding run the app command instead of going to the shell."
      resetAction={
        settings.terminalAppShortcutsFirst !==
        DEFAULT_UNIFIED_SETTINGS.terminalAppShortcutsFirst ? (
          <SettingResetButton
            label="app shortcuts in terminal"
            onClick={() =>
              updateSettings({
                terminalAppShortcutsFirst: DEFAULT_UNIFIED_SETTINGS.terminalAppShortcutsFirst,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.terminalAppShortcutsFirst}
          onCheckedChange={(checked) =>
            updateSettings({ terminalAppShortcutsFirst: Boolean(checked) })
          }
          aria-label="App shortcuts take priority in terminal"
        />
      }
    />
  );
}

/** Fork: `currentProjectTerminalOpensThread`. */
export function CurrentProjectTerminalOpensThreadSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("current-project-terminal-opens-thread")}
      description="New terminal thread in current project (Shift+click, its shortcut or the command palette) makes the terminal thread right away, like the enlarge button. The thread shows in the sidebar even if you never run a command."
      resetAction={
        settings.currentProjectTerminalOpensThread !==
        DEFAULT_UNIFIED_SETTINGS.currentProjectTerminalOpensThread ? (
          <SettingResetButton
            label="open terminal in current project as a thread"
            onClick={() =>
              updateSettings({
                currentProjectTerminalOpensThread:
                  DEFAULT_UNIFIED_SETTINGS.currentProjectTerminalOpensThread,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.currentProjectTerminalOpensThread}
          onCheckedChange={(checked) =>
            updateSettings({ currentProjectTerminalOpensThread: Boolean(checked) })
          }
          aria-label="Open terminal in current project as a thread"
        />
      }
    />
  );
}

/** Fork: `messagePins`. */
export function MessagePinsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("message-pins")}
      description="Pin a message with the pin button next to its copy buttons. Thread details list the pins of the thread. The sidebar lists all pins next to Usage. Every client of an environment shows its pins."
      resetAction={
        settings.messagePins !== DEFAULT_UNIFIED_SETTINGS.messagePins ? (
          <SettingResetButton
            label="message pins"
            onClick={() => updateSettings({ messagePins: DEFAULT_UNIFIED_SETTINGS.messagePins })}
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.messagePins}
          onCheckedChange={(checked) => updateSettings({ messagePins: Boolean(checked) })}
          aria-label="Message pins"
        />
      }
    />
  );
}

/** Fork: `backgroundWorkDetails`. */
export function BackgroundWorkDetailsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("background-work-details")}
      description="Click the status icon of a monitor, background command, or background agent to see its command and output file. Links in their descriptions open."
      resetAction={
        settings.backgroundWorkDetails !== DEFAULT_UNIFIED_SETTINGS.backgroundWorkDetails ? (
          <SettingResetButton
            label="background work details"
            onClick={() =>
              updateSettings({
                backgroundWorkDetails: DEFAULT_UNIFIED_SETTINGS.backgroundWorkDetails,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.backgroundWorkDetails}
          onCheckedChange={(checked) => updateSettings({ backgroundWorkDetails: Boolean(checked) })}
          aria-label="Background work details"
        />
      }
    />
  );
}

/** Fork: `restartReconnectWarningGrace` (forkReconnectWarningGrace.ts). */
export function RestartReconnectWarningGraceSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("restart-reconnect-warning-grace")}
      description="For the first 45 seconds after T3 Code starts, do not warn in the composer that a server is reconnecting. A refused sign-in or an offline device still shows at once."
      resetAction={
        settings.restartReconnectWarningGrace !==
        DEFAULT_UNIFIED_SETTINGS.restartReconnectWarningGrace ? (
          <SettingResetButton
            label="quiet reconnect after restart"
            onClick={() =>
              updateSettings({
                restartReconnectWarningGrace: DEFAULT_UNIFIED_SETTINGS.restartReconnectWarningGrace,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.restartReconnectWarningGrace}
          onCheckedChange={(checked) =>
            updateSettings({ restartReconnectWarningGrace: Boolean(checked) })
          }
          aria-label="Quiet reconnect after restart"
        />
      }
    />
  );
}

/** Fork: `checkNewerBeforeUpdateInstall`. Only the desktop app installs downloaded updates. */
export function CheckNewerBeforeUpdateInstallSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("check-newer-before-update-install")}
      description="Desktop app: before it installs a downloaded update, look for a newer release and offer it. Install when idle and the machine map take the newer release."
      resetAction={
        settings.checkNewerBeforeUpdateInstall !==
        DEFAULT_UNIFIED_SETTINGS.checkNewerBeforeUpdateInstall ? (
          <SettingResetButton
            label="check for a newer update before install"
            onClick={() =>
              updateSettings({
                checkNewerBeforeUpdateInstall:
                  DEFAULT_UNIFIED_SETTINGS.checkNewerBeforeUpdateInstall,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.checkNewerBeforeUpdateInstall}
          onCheckedChange={(checked) =>
            updateSettings({ checkNewerBeforeUpdateInstall: Boolean(checked) })
          }
          aria-label="Check for a newer update before install"
        />
      }
    />
  );
}

/** Fork: `forkAutoUpdate`. Only a server that runs as the background service uses it. */
export function ForkAutoUpdateSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["forkAutoUpdate"]);
  return (
    <SettingsRow
      {...searchableSetting("fork-auto-update")}
      serverScoped
      settingKeys={["forkAutoUpdate"]}
      description="A server that runs as the background service installs each newer fork release when no agent runs. The desktop app ignores it and uses its own updater."
      resetAction={
        mixed || settings.forkAutoUpdate !== DEFAULT_UNIFIED_SETTINGS.forkAutoUpdate ? (
          <SettingResetButton
            label="server auto-update"
            onClick={() =>
              updateSettings({ forkAutoUpdate: DEFAULT_UNIFIED_SETTINGS.forkAutoUpdate })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["forkAutoUpdate"]}
          checked={settings.forkAutoUpdate}
          onCheckedChange={(checked) => updateSettings({ forkAutoUpdate: Boolean(checked) })}
          aria-label="Server auto-update"
        />
      }
    />
  );
}

/** Fork: `autoSettleWaitsForBackgroundCommands`. */
export function AutoSettleWaitsForBackgroundCommandsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["autoSettleWaitsForBackgroundCommands"]);
  const { connectedEnvironments } = useSettingsScope();
  // Like the upstream auto-settle rows beside it.
  const supportsAutoSettlement =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadAutoSettlement === true,
    );
  if (!supportsAutoSettlement) return null;
  return (
    <SettingsRow
      {...searchableSetting("auto-settle-waits-for-background-commands")}
      serverScoped
      settingKeys={["autoSettleWaitsForBackgroundCommands"]}
      resetAction={
        mixed ||
        settings.autoSettleWaitsForBackgroundCommands !==
          DEFAULT_UNIFIED_SETTINGS.autoSettleWaitsForBackgroundCommands ? (
          <SettingResetButton
            label="auto-settle waits for background commands"
            onClick={() =>
              updateSettings({
                autoSettleWaitsForBackgroundCommands:
                  DEFAULT_UNIFIED_SETTINGS.autoSettleWaitsForBackgroundCommands,
              })
            }
          />
        ) : null
      }
      description="Auto-settle skips a thread while its agent runs a background command, so the command can finish and wake the agent. A command that keeps running, such as a dev server, holds the thread until the session releases idle work."
      control={
        <ScopedSwitch
          settingKeys={["autoSettleWaitsForBackgroundCommands"]}
          checked={settings.autoSettleWaitsForBackgroundCommands}
          onCheckedChange={(checked) =>
            updateSettings({ autoSettleWaitsForBackgroundCommands: Boolean(checked) })
          }
          aria-label="Auto-settle waits for background commands"
        />
      }
    />
  );
}
