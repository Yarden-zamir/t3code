export type SettingsSheetTarget =
  | "SettingsEnvironments"
  | "SettingsNotifications"
  | "SettingsThreads"
  | "SettingsAbout"
  | "SettingsArchive"
  | "SettingsAppearance"
  | "SettingsNavigation"
  | "SettingsOrganization"
  | "SettingsProjectOverview"
  | "SettingsEnvironmentNewThreads"
  | "SettingsEnvironmentSourceControl"
  | "SettingsEnvironmentAgentBehavior"
  | "SettingsEnvironmentMaintenance"
  | "SettingsProviderAccounts"
  | "SettingsKeyboard"
  | "SettingsMicrophone"
  | "SettingsFollowUp"
  | "SettingsScheduledTasks"
  | "SettingsProjectGrouping"
  | "SettingsClientStorage"
  | "SettingsDiagnostics"
  | "SettingsOpenSourceLicenses"
  | "SettingsUsage";

/**
 * Fork: apart from `SettingsSheetTarget`, because TypeScript checks a navigation to a union of at
 * most 25 screens. Merge them again if upstream splits its own list.
 */
export const FORK_SETTINGS_SHEET_TARGETS = [
  "SettingsFork",
  "SettingsVoice",
  "SettingsVoiceProject",
] as const;
export type ForkSettingsSheetTarget = (typeof FORK_SETTINGS_SHEET_TARGETS)[number];

export function isForkSettingsSheetTarget(
  target: SettingsSheetTarget | ForkSettingsSheetTarget,
): target is ForkSettingsSheetTarget {
  return (FORK_SETTINGS_SHEET_TARGETS as ReadonlyArray<string>).includes(target);
}

export type SettingsLegalDocumentTarget = "SettingsLegal";
