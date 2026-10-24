import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectEnabled = (settings: ClientSettings) => settings.sidebarTabsEnabled;
const selectSingleThreadOpens = (settings: ClientSettings) => settings.sidebarTabSingleThreadOpens;

/** Fork: `sidebarTabsEnabled` and `sidebarTabSingleThreadOpens`, sidebar tabs. */
export function SidebarTabsSettingsRow() {
  const enabled = useClientSettings(selectEnabled);
  const singleThreadOpens = useClientSettings(selectSingleThreadOpens);
  return (
    <>
      <SettingsRow
        {...searchableSetting("sidebar-tabs")}
        description="Put threads in tabs above the sidebar list. Drag a thread onto a tab, or onto the end of the tab bar for a new tab. Rules fill tabs too. The machine map syncs the tabs."
        resetAction={
          enabled !== DEFAULT_CLIENT_SETTINGS.sidebarTabsEnabled ? (
            <SettingResetButton
              label="sidebar tabs"
              onClick={() =>
                void updateClientSettings({
                  sidebarTabsEnabled: DEFAULT_CLIENT_SETTINGS.sidebarTabsEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              void updateClientSettings({ sidebarTabsEnabled: Boolean(checked) })
            }
            aria-label="Sidebar tabs"
          />
        }
      />
      {enabled ? (
        <SettingsRow
          {...searchableSetting("sidebar-tab-single-thread")}
          description="A tab with one thread shows that thread, and a click opens it."
          resetAction={
            singleThreadOpens !== DEFAULT_CLIENT_SETTINGS.sidebarTabSingleThreadOpens ? (
              <SettingResetButton
                label="single-thread tabs"
                onClick={() =>
                  void updateClientSettings({
                    sidebarTabSingleThreadOpens:
                      DEFAULT_CLIENT_SETTINGS.sidebarTabSingleThreadOpens,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={singleThreadOpens}
              onCheckedChange={(checked) =>
                void updateClientSettings({ sidebarTabSingleThreadOpens: Boolean(checked) })
              }
              aria-label="Single-thread tabs open the thread"
            />
          }
        />
      ) : null}
    </>
  );
}
