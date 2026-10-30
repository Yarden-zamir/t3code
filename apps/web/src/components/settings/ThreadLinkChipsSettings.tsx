import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function ThreadLinkChipsSettingsRow() {
  return (
    <ForkServerSwitchRow
      settingKey="threadLinkChips"
      searchId="thread-link-chips"
      label="Thread link chips"
      description="Thread links in chat show as attached-thread chips: app links, thread addresses of this or a connected machine, and the thread markers that agents copy. A click opens the thread here, not in a browser. Applies on desktop, web and the mobile app."
    />
  );
}

export function ThreadLinksOpenDesktopAppSettingsRow() {
  return (
    <ForkServerSwitchRow
      settingKey="threadLinksOpenDesktopApp"
      searchId="thread-links-open-desktop-app"
      label="Thread addresses open the desktop app"
      description="A thread address opened from another app, such as Slack or GitHub, in a new browser tab opens the thread in the desktop app at once. The tab offers to continue in the browser."
    />
  );
}

export function MessageLinksSettingsRow() {
  return (
    <ForkServerSwitchRow
      settingKey="messageLinks"
      searchId="message-links"
      label="Message links"
      description="A thread link that names a message, such as one an agent writes, opens the thread at that message and highlights it. Off: the link opens the thread only, and Copy message link is hidden. Applies on desktop, web and the mobile app."
    />
  );
}

/** Fork: a switch row of a boolean fork server setting. */
function ForkServerSwitchRow(props: {
  readonly settingKey: "threadLinkChips" | "threadLinksOpenDesktopApp" | "messageLinks";
  readonly searchId: "thread-link-chips" | "thread-links-open-desktop-app" | "message-links";
  readonly label: string;
  readonly description: string;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed([props.settingKey]);
  const fallback = DEFAULT_SERVER_SETTINGS[props.settingKey];

  return (
    <SettingsRow
      {...searchableSetting(props.searchId)}
      serverScoped
      settingKeys={[props.settingKey]}
      description={props.description}
      resetAction={
        mixed || settings[props.settingKey] !== fallback ? (
          <SettingResetButton
            label={props.label.toLowerCase()}
            onClick={() => updateSettings({ [props.settingKey]: fallback })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={[props.settingKey]}
          checked={settings[props.settingKey]}
          onCheckedChange={(checked) => updateSettings({ [props.settingKey]: Boolean(checked) })}
          aria-label={props.label}
        />
      }
    />
  );
}
