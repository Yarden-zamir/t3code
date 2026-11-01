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
      description="Before the next turn, recreate a missing worktree at its saved path and run project setup. If its branch was deleted, the branch is created again from the origin default branch, without the old uncommitted work. An existing branch is never reset. Storage cleanup also deletes the branch of a removed worktree when it has no commits beyond the origin default branch and no worktree uses it."
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
      description="Delete ignored build outputs and dependencies from worktrees that are inactive for this many days, or settled for one minute. The checkout and branch stay. Shared or busy worktrees and projects without a setup script are skipped. Removed dependencies come back through project setup before the next turn."
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
