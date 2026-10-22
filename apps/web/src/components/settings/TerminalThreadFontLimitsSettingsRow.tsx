import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  MAX_TERMINAL_THREAD_FONT_LIMIT,
  MIN_TERMINAL_THREAD_FONT_LIMIT,
} from "@t3tools/contracts";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { BoundedIntegerInput } from "./BoundedIntegerInput";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectLimits = (settings: ClientSettings) => ({
  min: settings.terminalThreadFontSizeMin,
  max: settings.terminalThreadFontSizeMax,
});

/**
 * Fork: `terminalThreadFontSizeMin` and `terminalThreadFontSizeMax`, the font sizes that the zoom
 * keys of a terminal thread reach.
 */
export function TerminalThreadFontLimitsSettingsRow() {
  const limits = useClientSettings(selectLimits);
  const updateSettings = useUpdateClientSettings();
  return (
    <SettingsRow
      {...searchableSetting("terminal-thread-font-limits")}
      description="The smallest and largest terminal font size in points that zoom reaches in a terminal thread. Zoom keys: Cmd + = , Cmd + - and Cmd + 0 (Ctrl + Shift on Windows and Linux)."
      resetAction={
        limits.min !== DEFAULT_CLIENT_SETTINGS.terminalThreadFontSizeMin ||
        limits.max !== DEFAULT_CLIENT_SETTINGS.terminalThreadFontSizeMax ? (
          <SettingResetButton
            label="terminal zoom limits"
            onClick={() =>
              void updateSettings({
                terminalThreadFontSizeMin: DEFAULT_CLIENT_SETTINGS.terminalThreadFontSizeMin,
                terminalThreadFontSizeMax: DEFAULT_CLIENT_SETTINGS.terminalThreadFontSizeMax,
              })
            }
          />
        ) : null
      }
      control={
        <div className="flex items-center gap-2">
          <BoundedIntegerInput
            value={limits.min}
            min={MIN_TERMINAL_THREAD_FONT_LIMIT}
            max={Math.min(limits.max, MAX_TERMINAL_THREAD_FONT_LIMIT)}
            onCommit={(value) => void updateSettings({ terminalThreadFontSizeMin: value })}
            aria-label="Smallest terminal font size"
          />
          <span aria-hidden="true">to</span>
          <BoundedIntegerInput
            value={limits.max}
            min={Math.max(limits.min, MIN_TERMINAL_THREAD_FONT_LIMIT)}
            max={MAX_TERMINAL_THREAD_FONT_LIMIT}
            onCommit={(value) => void updateSettings({ terminalThreadFontSizeMax: value })}
            aria-label="Largest terminal font size"
          />
        </div>
      }
    />
  );
}
