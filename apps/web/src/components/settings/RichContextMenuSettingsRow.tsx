import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectEnabled = (settings: ClientSettings) => settings.richContextMenu;

/** Fork: `richContextMenu`, right-click menus use the app's own menu. */
export function RichContextMenuSettingsRow() {
  const enabled = useClientSettings(selectEnabled);
  return (
    <SettingsRow
      {...searchableSetting("rich-context-menu")}
      description="Right-click menus use the app's own menu, also in the desktop app: the app theme, icons, group names, arrow keys and typing to pick an item, and Keybinds… on items that a shortcut can run. Turn it off to use the system menu. Text fields and pages in the browser panel always keep the system menu."
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.richContextMenu ? (
          <SettingResetButton
            label="app context menu"
            onClick={() =>
              void updateClientSettings({
                richContextMenu: DEFAULT_CLIENT_SETTINGS.richContextMenu,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateClientSettings({ richContextMenu: Boolean(checked) })
          }
          aria-label="App context menu"
        />
      }
    />
  );
}
