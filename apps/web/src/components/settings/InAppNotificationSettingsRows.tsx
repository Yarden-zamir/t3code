import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  MAX_IN_APP_NOTIFICATION_SECONDS,
  MIN_IN_APP_NOTIFICATION_SECONDS,
} from "@t3tools/contracts";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { BoundedIntegerInput } from "./BoundedIntegerInput";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { type SettingsSearchItemId, searchableSetting } from "./settingsSearch";

type InAppNotificationSwitchKey =
  | "inAppNotificationCompletions"
  | "inAppNotificationAttentionStays"
  | "inAppNotificationClosesOnOpen";

function InAppNotificationSwitchRow(props: {
  readonly id: SettingsSearchItemId;
  readonly settingKey: InAppNotificationSwitchKey;
  readonly label: string;
  readonly description: string;
}) {
  const { settingKey } = props;
  const checked = useClientSettings((settings: ClientSettings) => settings[settingKey]);
  return (
    <SettingsRow
      {...searchableSetting(props.id)}
      description={props.description}
      resetAction={
        checked !== DEFAULT_CLIENT_SETTINGS[settingKey] ? (
          <SettingResetButton
            label={props.label.toLowerCase()}
            onClick={() =>
              void updateClientSettings({ [settingKey]: DEFAULT_CLIENT_SETTINGS[settingKey] })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={checked}
          onCheckedChange={(next) => void updateClientSettings({ [settingKey]: Boolean(next) })}
          aria-label={props.label}
        />
      }
    />
  );
}

const selectSeconds = (settings: ClientSettings) => settings.inAppNotificationSeconds;

/** Fork: how long in-app thread notifications show, which ones show, and when they close. */
export function InAppNotificationSettingsRows() {
  const seconds = useClientSettings(selectSeconds);
  return (
    <>
      <SettingsRow
        {...searchableSetting("in-app-notification-seconds")}
        description="Seconds that an in-app notification shows. The time stops while the pointer is on it."
        resetAction={
          seconds !== DEFAULT_CLIENT_SETTINGS.inAppNotificationSeconds ? (
            <SettingResetButton
              label="in-app notification time"
              onClick={() =>
                void updateClientSettings({
                  inAppNotificationSeconds: DEFAULT_CLIENT_SETTINGS.inAppNotificationSeconds,
                })
              }
            />
          ) : null
        }
        control={
          <BoundedIntegerInput
            value={seconds}
            min={MIN_IN_APP_NOTIFICATION_SECONDS}
            max={MAX_IN_APP_NOTIFICATION_SECONDS}
            onCommit={(value) => void updateClientSettings({ inAppNotificationSeconds: value })}
            aria-label="In-app notification time"
          />
        }
      />
      <InAppNotificationSwitchRow
        id="in-app-notification-completions"
        settingKey="inAppNotificationCompletions"
        label="Notify when a thread finishes"
        description="Show an in-app notification when a thread or terminal program finishes. Off shows only threads that need input or approval, or that failed."
      />
      <InAppNotificationSwitchRow
        id="in-app-notification-attention-stays"
        settingKey="inAppNotificationAttentionStays"
        label="Keep notifications that need you"
        description="Notifications for input, approval or a failure stay until you close them."
      />
      <InAppNotificationSwitchRow
        id="in-app-notification-closes-on-open"
        settingKey="inAppNotificationClosesOnOpen"
        label="Close notifications of an opened thread"
        description="When you open a thread in any way, its in-app notifications close."
      />
    </>
  );
}
