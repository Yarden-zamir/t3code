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
      description="Before the next turn, recreate a missing worktree at its saved path and run project setup. If its branch was deleted, the branch is created again from the origin default branch, without the old uncommitted work. An existing branch is never reset."
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

export function WorktreeArtifactSettingsRows() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const evictionMixed = useScopedSettingsMixed(["worktreeArtifactEviction"]);
  const daysMixed = useScopedSettingsMixed(["worktreeArtifactEvictionDays"]);
  return (
    <>
      <SettingsRow
        {...searchableSetting("worktree-artifact-eviction")}
        serverScoped
        settingKeys={["worktreeArtifactEviction"]}
        resetAction={
          evictionMixed ||
          settings.worktreeArtifactEviction !== DEFAULT_SERVER_SETTINGS.worktreeArtifactEviction ? (
            <SettingResetButton
              label="evict worktree artifacts"
              onClick={() =>
                update({
                  worktreeArtifactEviction: DEFAULT_SERVER_SETTINGS.worktreeArtifactEviction,
                })
              }
            />
          ) : null
        }
        description="Delete ignored build outputs and dependencies from settled or inactive worktrees. The checkout and branch stay. Shared or busy worktrees and projects without a setup script are skipped. Removed dependencies come back through project setup before the next turn."
        control={
          <ScopedSwitch
            settingKeys={["worktreeArtifactEviction"]}
            checked={settings.worktreeArtifactEviction}
            onCheckedChange={(checked) => update({ worktreeArtifactEviction: Boolean(checked) })}
            aria-label="Evict worktree artifacts"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("worktree-artifact-eviction-days")}
        serverScoped
        settingKeys={["worktreeArtifactEvictionDays"]}
        resetAction={
          daysMixed ||
          settings.worktreeArtifactEvictionDays !==
            DEFAULT_SERVER_SETTINGS.worktreeArtifactEvictionDays ? (
            <SettingResetButton
              label="artifact eviction inactivity days"
              onClick={() =>
                update({
                  worktreeArtifactEvictionDays:
                    DEFAULT_SERVER_SETTINGS.worktreeArtifactEvictionDays,
                })
              }
            />
          ) : null
        }
        description="Unsettled threads must be inactive for this many days. Settled threads qualify one minute after they settle."
        control={
          <Input
            key={settings.worktreeArtifactEvictionDays}
            type="number"
            min={1}
            max={3650}
            defaultValue={settings.worktreeArtifactEvictionDays}
            aria-label="Artifact eviction inactivity days"
            onBlur={(event) => {
              const days = Number(event.target.value);
              if (Number.isInteger(days) && days >= 1 && days <= 3650)
                update({ worktreeArtifactEvictionDays: days });
            }}
          />
        }
      />
    </>
  );
}
