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
      description="Thread links in chat show as attached-thread chips and open the thread here: app links, thread addresses of this or a connected machine, and the thread markers that agents copy. Each message offers Copy message link. A thread address opened from another app, such as Slack or GitHub, in a new browser tab opens the thread in the desktop app; the tab offers to continue in the browser. Applies on desktop, web and the mobile app."
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
