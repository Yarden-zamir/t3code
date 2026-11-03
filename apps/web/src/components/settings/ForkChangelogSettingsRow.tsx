import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectForkChangelogEnabled = (settings: ClientSettings) => settings.forkChangelogEnabled;

/** Fork setting: turns on the Changelog tab of the Fleet view, and links to it. */
export function ForkChangelogSettingsRow() {
  const enabled = useClientSettings(selectForkChangelogEnabled);

  return (
    <SettingsRow
      {...searchableSetting("fork-changelog")}
      description="Browse fork releases and their fork and upstream changes, see what upstream has that the fork does not, and start Fork Sync. A tab of Settings > Fleet; the update button opens it too."
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.forkChangelogEnabled ? (
          <SettingResetButton
            label="fork changelog"
            onClick={() =>
              void updateClientSettings({
                forkChangelogEnabled: DEFAULT_CLIENT_SETTINGS.forkChangelogEnabled,
              })
            }
          />
        ) : null
      }
      control={
        <div className="flex items-center gap-2">
          {enabled ? (
            <Button
              size="sm"
              variant="outline"
              render={<Link to="/settings/machines" search={{ tab: "changelog" }} />}
            >
              Open
            </Button>
          ) : null}
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              void updateClientSettings({ forkChangelogEnabled: Boolean(checked) })
            }
            aria-label="Fork changelog"
          />
        </div>
      }
    />
  );
}
