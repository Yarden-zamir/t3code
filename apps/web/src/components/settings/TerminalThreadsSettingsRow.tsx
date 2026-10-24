import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: `terminalThreads`, threads whose main view is a terminal. */
export function TerminalThreadsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["terminalThreads"]);

  return (
    <SettingsRow
      {...searchableSetting("terminal-threads")}
      serverScoped
      settingKeys={["terminalThreads"]}
      description="The sidebar and the command palette offer New terminal thread: a thread whose view is a terminal. A message to the thread, from a schedule or an agent, is typed into that terminal. A webhook task never types into a terminal thread."
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
