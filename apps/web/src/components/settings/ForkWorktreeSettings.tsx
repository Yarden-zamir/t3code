import { ScopedSwitch } from "./ScopedSwitch";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function RestoreWorktreesSettingsRow() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("restore-worktrees-on-resume")}
      serverScoped
      settingKeys={["restoreWorktreesOnResume"]}
      description="Restore a missing checkout from its saved local branch, then run project setup before the next turn. Also runs setup when a Node project's dependencies are missing. Never creates or resets a branch."
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
  return (
    <>
      <SettingsRow
        {...searchableSetting("worktree-artifact-eviction")}
        serverScoped
        settingKeys={["worktreeArtifactEviction"]}
        description="Remove only reviewed generated directories from settled or inactive worktrees. Keeps the checkout, branch and protected contents. Skips shared or busy worktrees. Missing dependencies run project setup before the next turn; removed builds return on the next build, not on resume. This does not disable upstream whole-worktree cleanup rules."
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
        description="Unsettled threads must be inactive for this many days. Settled threads are eligible after their settle script grace period."
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
