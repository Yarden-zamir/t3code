import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function EnvironmentLabelSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["environmentLabelFromMachineMap"]);
  return (
    <SettingsRow
      {...searchableSetting("environment-label-from-machine-map")}
      serverScoped
      settingKeys={["environmentLabelFromMachineMap"]}
      description="Use the kitshn map name of this machine for this environment. Name changes on the kitshn map appear without a restart."
      resetAction={
        mixed ||
        settings.environmentLabelFromMachineMap !==
          DEFAULT_SERVER_SETTINGS.environmentLabelFromMachineMap ? (
          <SettingResetButton
            label="environment name from kitshn"
            onClick={() =>
              updateSettings({
                environmentLabelFromMachineMap:
                  DEFAULT_SERVER_SETTINGS.environmentLabelFromMachineMap,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["environmentLabelFromMachineMap"]}
          checked={settings.environmentLabelFromMachineMap}
          onCheckedChange={(checked) =>
            updateSettings({ environmentLabelFromMachineMap: Boolean(checked) })
          }
          aria-label="Use the kitshn environment name"
        />
      }
    />
  );
}
