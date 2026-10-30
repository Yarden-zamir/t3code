import {
  DEFAULT_SERVER_SETTINGS,
  MobileNewThreadProject,
  type MobileNewThreadProject as MobileNewThreadProjectValue,
} from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const NEW_THREAD_LABELS = {
  picker: "Choose a project",
  last: "Last project",
  none: "No project",
} satisfies Record<MobileNewThreadProjectValue, string>;

export function MobilePublishedThemesSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mobilePublishedThemes"]);
  const fallback = DEFAULT_SERVER_SETTINGS.mobilePublishedThemes;
  return (
    <SettingsRow
      {...searchableSetting("mobile-published-themes")}
      serverScoped
      settingKeys={["mobilePublishedThemes"]}
      description="The mobile app offers the themes that this server publishes, with their fonts, shape and canvas pattern, and takes the default theme."
      resetAction={
        mixed || settings.mobilePublishedThemes !== fallback ? (
          <SettingResetButton
            label="published themes on mobile"
            onClick={() => updateSettings({ mobilePublishedThemes: fallback })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["mobilePublishedThemes"]}
          checked={settings.mobilePublishedThemes}
          onCheckedChange={(checked) => updateSettings({ mobilePublishedThemes: Boolean(checked) })}
          aria-label="Published themes on mobile"
        />
      }
    />
  );
}

export function MobileComposerCameraSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mobileComposerCamera"]);
  const fallback = DEFAULT_SERVER_SETTINGS.mobileComposerCamera;
  return (
    <SettingsRow
      {...searchableSetting("mobile-composer-camera")}
      serverScoped
      settingKeys={["mobileComposerCamera"]}
      description="The plus button of the mobile composer offers Take Photo, next to the photo library and files."
      resetAction={
        mixed || settings.mobileComposerCamera !== fallback ? (
          <SettingResetButton
            label="camera on mobile"
            onClick={() => updateSettings({ mobileComposerCamera: fallback })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["mobileComposerCamera"]}
          checked={settings.mobileComposerCamera}
          onCheckedChange={(checked) => updateSettings({ mobileComposerCamera: Boolean(checked) })}
          aria-label="Camera on mobile"
        />
      }
    />
  );
}

export function MobileMessagePinsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mobileMessagePins"]);
  const fallback = DEFAULT_SERVER_SETTINGS.mobileMessagePins;
  return (
    <SettingsRow
      {...searchableSetting("mobile-message-pins")}
      serverScoped
      settingKeys={["mobileMessagePins"]}
      description="A long press on a message in the mobile app offers Pin and Unpin. Pinned messages show in the sidebar and in thread details of the desktop and web app."
      resetAction={
        mixed || settings.mobileMessagePins !== fallback ? (
          <SettingResetButton
            label="message pins on mobile"
            onClick={() => updateSettings({ mobileMessagePins: fallback })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["mobileMessagePins"]}
          checked={settings.mobileMessagePins}
          onCheckedChange={(checked) => updateSettings({ mobileMessagePins: Boolean(checked) })}
          aria-label="Message pins on mobile"
        />
      }
    />
  );
}

export function MobileNewThreadProjectSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mobileNewThreadProject"]);
  const fallback = DEFAULT_SERVER_SETTINGS.mobileNewThreadProject;
  return (
    <SettingsRow
      {...searchableSetting("mobile-new-thread-project")}
      serverScoped
      settingKeys={["mobileNewThreadProject"]}
      description="What New thread opens in the mobile app: the project list, a draft in the project of the last new thread on the phone, or a draft without a project."
      resetAction={
        mixed || settings.mobileNewThreadProject !== fallback ? (
          <SettingResetButton
            label="new thread on mobile"
            onClick={() => updateSettings({ mobileNewThreadProject: fallback })}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : settings.mobileNewThreadProject}
          onValueChange={(value) => {
            if (MobileNewThreadProject.literals.includes(value as MobileNewThreadProjectValue)) {
              updateSettings({ mobileNewThreadProject: value as MobileNewThreadProjectValue });
            }
          }}
        >
          <SelectTrigger size="sm" aria-label="New thread on mobile">
            <SelectValue>
              {(value: MobileNewThreadProjectValue | null) =>
                value === null ? "Mixed" : NEW_THREAD_LABELS[value]
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {MobileNewThreadProject.literals.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {NEW_THREAD_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function MobileWarmRecentChatsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mobileWarmRecentChats"]);
  const fallback = DEFAULT_SERVER_SETTINGS.mobileWarmRecentChats;
  return (
    <SettingsRow
      {...searchableSetting("mobile-warm-recent-chats")}
      serverScoped
      settingKeys={["mobileWarmRecentChats"]}
      description="After the thread list syncs, the mobile app loads the newest threads into its message cache, so they open without a wait."
      resetAction={
        mixed || settings.mobileWarmRecentChats !== fallback ? (
          <SettingResetButton
            label="warm recent chats on mobile"
            onClick={() => updateSettings({ mobileWarmRecentChats: fallback })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["mobileWarmRecentChats"]}
          checked={settings.mobileWarmRecentChats}
          onCheckedChange={(checked) => updateSettings({ mobileWarmRecentChats: Boolean(checked) })}
          aria-label="Warm recent chats on mobile"
        />
      }
    />
  );
}

export function MobileSidebarTabsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mobileSidebarTabs"]);
  const fallback = DEFAULT_SERVER_SETTINGS.mobileSidebarTabs;
  return (
    <SettingsRow
      {...searchableSetting("mobile-sidebar-tabs")}
      serverScoped
      settingKeys={["mobileSidebarTabs"]}
      description="The thread list of the mobile app shows the sidebar tabs. Tap a tab to show its threads."
      resetAction={
        mixed || settings.mobileSidebarTabs !== fallback ? (
          <SettingResetButton
            label="sidebar tabs on mobile"
            onClick={() => updateSettings({ mobileSidebarTabs: fallback })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["mobileSidebarTabs"]}
          checked={settings.mobileSidebarTabs}
          onCheckedChange={(checked) => updateSettings({ mobileSidebarTabs: Boolean(checked) })}
          aria-label="Sidebar tabs on mobile"
        />
      }
    />
  );
}
