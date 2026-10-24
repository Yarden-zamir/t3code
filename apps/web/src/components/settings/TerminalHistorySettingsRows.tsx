import {
  DEFAULT_SERVER_SETTINGS,
  MAX_TERMINAL_HISTORY_LINES,
  MAX_TERMINAL_HISTORY_MEGABYTES,
  MIN_TERMINAL_HISTORY_LINES,
  MIN_TERMINAL_HISTORY_MEGABYTES,
} from "@t3tools/contracts";

import { BoundedIntegerInput } from "./BoundedIntegerInput";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Fork: `terminalHistoryLines` and `terminalHistoryMegabytes`, the output kept for each terminal. */
export function TerminalHistorySettingsRows() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("terminal-history")}
      serverScoped
      settingKeys={["terminalHistoryLines", "terminalHistoryMegabytes"]}
      description="How much output the server keeps for each terminal, so a terminal that opens again shows its past output. Whichever limit is reached first applies. Applies after the server restarts."
      resetAction={
        settings.terminalHistoryLines !== DEFAULT_SERVER_SETTINGS.terminalHistoryLines ||
        settings.terminalHistoryMegabytes !== DEFAULT_SERVER_SETTINGS.terminalHistoryMegabytes ? (
          <SettingResetButton
            label="terminal history"
            onClick={() =>
              updateSettings({
                terminalHistoryLines: DEFAULT_SERVER_SETTINGS.terminalHistoryLines,
                terminalHistoryMegabytes: DEFAULT_SERVER_SETTINGS.terminalHistoryMegabytes,
              })
            }
          />
        ) : null
      }
      control={
        <div className="flex items-center gap-2">
          <BoundedIntegerInput
            value={settings.terminalHistoryLines}
            min={MIN_TERMINAL_HISTORY_LINES}
            max={MAX_TERMINAL_HISTORY_LINES}
            onCommit={(value) => updateSettings({ terminalHistoryLines: value })}
            aria-label="Terminal history lines"
          />
          <span aria-hidden="true">lines,</span>
          <BoundedIntegerInput
            value={settings.terminalHistoryMegabytes}
            min={MIN_TERMINAL_HISTORY_MEGABYTES}
            max={MAX_TERMINAL_HISTORY_MEGABYTES}
            onCommit={(value) => updateSettings({ terminalHistoryMegabytes: value })}
            aria-label="Terminal history megabytes"
          />
          <span aria-hidden="true">MB</span>
        </div>
      }
    />
  );
}
