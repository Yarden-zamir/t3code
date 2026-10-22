import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: `terminalThreads`, threads whose main view is a tmux terminal. */
export function TerminalThreadsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["terminalThreads"]);

  return (
    <SettingsRow
      {...searchableSetting("terminal-threads")}
      serverScoped
      settingKeys={["terminalThreads"]}
      description="The sidebar and the command palette offer New terminal thread: a thread whose view is a terminal. A message to the thread, from a schedule, a webhook or an agent, is typed into that terminal."
      resetAction={
        mixed || settings.terminalThreads !== DEFAULT_SERVER_SETTINGS.terminalThreads ? (
          <SettingResetButton
            label="terminal threads"
            onClick={() =>
              updateSettings({ terminalThreads: DEFAULT_SERVER_SETTINGS.terminalThreads })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["terminalThreads"]}
          checked={settings.terminalThreads}
          onCheckedChange={(checked) => updateSettings({ terminalThreads: Boolean(checked) })}
          aria-label="Terminal threads"
        />
      }
    />
  );
}

/** Fork: `terminalThreadsTmux`, terminal threads run inside tmux. */
export function TerminalThreadsTmuxSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["terminalThreadsTmux"]);

  return (
    <SettingsRow
      {...searchableSetting("terminal-threads-tmux")}
      serverScoped
      settingKeys={["terminalThreadsTmux"]}
      description="A terminal thread runs inside tmux, so its apps keep running when the server restarts and tmux search works. Needs tmux on the server machine; without it the thread runs a plain shell. Applies to terminals that open after the change. Pair it with the tmux search keys in Terminal key mappings."
      resetAction={
        mixed || settings.terminalThreadsTmux !== DEFAULT_SERVER_SETTINGS.terminalThreadsTmux ? (
          <SettingResetButton
            label="terminal threads in tmux"
            onClick={() =>
              updateSettings({ terminalThreadsTmux: DEFAULT_SERVER_SETTINGS.terminalThreadsTmux })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["terminalThreadsTmux"]}
          checked={settings.terminalThreadsTmux}
          onCheckedChange={(checked) => updateSettings({ terminalThreadsTmux: Boolean(checked) })}
          aria-label="Terminal threads in tmux"
        />
      }
    />
  );
}
