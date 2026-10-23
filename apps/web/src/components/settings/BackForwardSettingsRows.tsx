import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectButtons = (settings: ClientSettings) => settings.backForwardButtons;
const selectRemember = (settings: ClientSettings) => settings.rememberBackForwardHistory;

/** Fork: `backForwardButtons`, back and forward buttons in the title bar. */
export function BackForwardButtonsSettingsRow() {
  const enabled = useClientSettings(selectButtons);
  return (
    <SettingsRow
      {...searchableSetting("back-forward-buttons")}
      description="Show back and forward buttons next to the sidebar toggle. The keys and the command palette work also without them."
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.backForwardButtons ? (
          <SettingResetButton
            label="back and forward buttons"
            onClick={() =>
              void updateClientSettings({
                backForwardButtons: DEFAULT_CLIENT_SETTINGS.backForwardButtons,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateClientSettings({ backForwardButtons: Boolean(checked) })
          }
          aria-label="Back and forward buttons"
        />
      }
    />
  );
}

/** Fork: `rememberBackForwardHistory`, the desktop app keeps its back history after a restart. */
export function RememberBackForwardHistorySettingsRow() {
  const enabled = useClientSettings(selectRemember);
  return (
    <SettingsRow
      {...searchableSetting("remember-back-forward-history")}
      description="Back and forward skip threads and drafts that no longer exist. The desktop app also keeps its back history after a restart."
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.rememberBackForwardHistory ? (
          <SettingResetButton
            label="back and forward history"
            onClick={() =>
              void updateClientSettings({
                rememberBackForwardHistory: DEFAULT_CLIENT_SETTINGS.rememberBackForwardHistory,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateClientSettings({ rememberBackForwardHistory: Boolean(checked) })
          }
          aria-label="Remember back and forward history"
        />
      }
    />
  );
}
