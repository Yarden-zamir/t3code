import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function RestoreWorktreesSettingsRow() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["restoreWorktreesOnResume"]);
  return (
    <SettingsRow
      {...searchableSetting("restore-worktrees-on-resume")}
      serverScoped
      settingKeys={["restoreWorktreesOnResume"]}
      resetAction={
        mixed ||
        settings.restoreWorktreesOnResume !== DEFAULT_SERVER_SETTINGS.restoreWorktreesOnResume ? (
          <SettingResetButton
            label="restore worktrees on resume"
            onClick={() =>
              update({ restoreWorktreesOnResume: DEFAULT_SERVER_SETTINGS.restoreWorktreesOnResume })
            }
          />
        ) : null
      }
      description="Recreate a missing worktree and run setup before the next turn. A deleted branch returns from origin; an existing branch is never reset. Cleanup removes unused branches without new commits."
      control={
        <ScopedSwitch
          settingKeys={["restoreWorktreesOnResume"]}
          checked={settings.restoreWorktreesOnResume}
          onCheckedChange={(checked) => update({ restoreWorktreesOnResume: Boolean(checked) })}
          aria-label="Restore worktrees on resume"
        />
      }
    />
  );
}

const ARTIFACTS_DEFAULT_DAYS = 14;

export function WorktreeArtifactSettingsRows() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreeArtifactsAfterDays"]);
  const days = settings.worktreeArtifactsAfterDays;
  return (
    <SettingsRow
      {...searchableSetting("worktree-artifact-eviction")}
      serverScoped
      settingKeys={["worktreeArtifactsAfterDays"]}
      resetAction={
        mixed || days !== DEFAULT_SERVER_SETTINGS.worktreeArtifactsAfterDays ? (
          <SettingResetButton
            label="evict worktree artifacts"
            onClick={() =>
              update({
                worktreeArtifactsAfterDays: DEFAULT_SERVER_SETTINGS.worktreeArtifactsAfterDays,
              })
            }
          />
        ) : null
      }
      description="Delete ignored build outputs and dependencies of worktrees inactive this many days, or settled a minute. Skips shared or busy worktrees and projects without setup. Setup restores them later."
      control={
        <span className="flex items-center gap-2">
          {days !== null && !mixed ? (
            <Input
              key={days}
              size="sm"
              className="w-20"
              type="number"
              min={1}
              max={3650}
              defaultValue={days}
              aria-label="Artifact eviction inactivity days"
              onBlur={(event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 1 && value <= 3650)
                  update({ worktreeArtifactsAfterDays: value });
              }}
            />
          ) : null}
          <ScopedSwitch
            settingKeys={["worktreeArtifactsAfterDays"]}
            checked={days !== null}
            onCheckedChange={(checked) =>
              update({ worktreeArtifactsAfterDays: checked ? ARTIFACTS_DEFAULT_DAYS : null })
            }
            aria-label="Evict worktree artifacts"
          />
        </span>
      }
    />
  );
}
