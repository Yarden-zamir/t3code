/** Settings pages a Settings row opens. */
export const SETTINGS_PAGE_TARGETS = [
  "SettingsEnvironments",
  "SettingsNotifications",
  "SettingsThreads",
  "SettingsAbout",
  "SettingsArchive",
  "SettingsAppearance",
  "SettingsNavigation",
  "SettingsOrganization",
  "SettingsProjectOverview",
  "SettingsEnvironmentNewThreads",
  "SettingsEnvironmentSourceControl",
  "SettingsEnvironmentAgentBehavior",
  "SettingsEnvironmentMaintenance",
  "SettingsProviderAccounts",
  "SettingsKeyboard",
  "SettingsMicrophone",
  "SettingsFollowUp",
  "SettingsScheduledTasks",
  "SettingsProjectGrouping",
  "SettingsClientStorage",
  "SettingsDiagnostics",
  "SettingsOpenSourceLicenses",
  "SettingsUsage",
] as const;

export type SettingsPageTarget = (typeof SETTINGS_PAGE_TARGETS)[number];

/**
 * Fork: the fork settings pages a Settings row opens. Apart from `SETTINGS_PAGE_TARGETS`, so
 * Settings does not reopen them as its remembered page (the Voice project page needs the project
 * that the Voice page chose), and so each navigation to a target union stays within the 25
 * members that TypeScript checks.
 */
export const FORK_SETTINGS_PAGE_TARGETS = [
  "SettingsFork",
  "SettingsVoice",
  "SettingsVoiceProject",
] as const;
export type ForkSettingsPageTarget = (typeof FORK_SETTINGS_PAGE_TARGETS)[number];

export function isForkSettingsPageTarget(
  target: SettingsPageTarget | ForkSettingsPageTarget,
): target is ForkSettingsPageTarget {
  return (FORK_SETTINGS_PAGE_TARGETS as ReadonlyArray<string>).includes(target);
}

export type SettingsLegalDocumentTarget = "SettingsLegal";
