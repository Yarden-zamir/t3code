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
      description="The command palette offers New terminal thread. Its view is a terminal that runs inside tmux, so apps keep running when the server restarts. Needs tmux on the server machine; without it the thread runs a plain shell."
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
