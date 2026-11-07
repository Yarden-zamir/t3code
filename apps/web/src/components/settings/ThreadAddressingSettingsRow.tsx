import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: `threadAddressing`, thread link chips, Copy message link and the desktop app handoff. */
export function ThreadAddressingSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["threadAddressing"]);

  return (
    <SettingsRow
      {...searchableSetting("thread-addressing")}
      serverScoped
      settingKeys={["threadAddressing"]}
      description="Thread links and addresses in chat show as thread chips that open here. Each message offers Copy message link. An address opened from another app opens in the desktop app. Desktop, web and mobile."
      resetAction={
        mixed || settings.threadAddressing !== DEFAULT_SERVER_SETTINGS.threadAddressing ? (
          <SettingResetButton
            label="thread addressing"
            onClick={() =>
              updateSettings({ threadAddressing: DEFAULT_SERVER_SETTINGS.threadAddressing })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["threadAddressing"]}
          checked={settings.threadAddressing}
          onCheckedChange={(checked) => updateSettings({ threadAddressing: Boolean(checked) })}
          aria-label="Thread addressing"
        />
      }
    />
  );
}
