import { describe, expect, it } from "@effect/vitest";

import {
  isCircleSetting,
  isMachineLocalSetting,
  KEYBINDINGS_SETTING_KEY,
  type SettingScope,
} from "./machineMap.ts";
import {
  ClientSettingsSchema,
  type ServerSettings,
  ServerSettings as ServerSettingsSchema,
} from "./settings.ts";

/**
 * The third column: keys that only the shared and machine parts set. A new setting key fails the
 * test below until it is put in one column, so each key gets a decision.
 */
const SHARED_ONLY_SETTINGS: Readonly<Record<SettingScope, ReadonlyArray<string>>> = {
  server: [
    "agentSessionImportMaxMessages",
    "agentSessionImportWindowDays",
    "autoResumeLimitedThreads",
    "autoSettleWaitsForBackgroundCommands",
    "automaticGitFetchInterval",
    "backgroundActivity",
    "backgroundActivityProfile",
    "branchNameInstructions",
    "branchNamePrefix",
    "branchNamingMode",
    "compactIdleThreads",
    "continueThreadsAfterServerUpdate",
    "defaultAutoPull",
    "defaultModelSelection",
    "defaultProjectScripts",
    "defaultRuntimeMode",
    "defaultThreadEnvMode",
    "easDeviceHosts",
    "enableAgentBrowserAccess",
    "enableAgentDeviceAccess",
    "ghqCloneLayout",
    "enableDeviceSupport",
    "enableProviderUpdateChecks",
    "environmentLabelFromMachineMap",
    "fallbackModelSelection",
    "forkUpdateMode",
    "globalScripts",
    "guestSharingEnabled",
    "idleCompaction",
    "keybindingSync",
    "linkedEnvironmentsEnabled",
    "mobilePublishedThemes",
    "newWorktreesStartFromOrigin",
    "observability",
    "preferOriginRemote",
    "previewLocalServerGroups",
    "providerHealthRefreshInterval",
    "providerModelPreferences",
    "pullRequestMergeMethod",
    "pullRequestWatchRemarkFilter",
    "recoverInterruptedTurns",
    "recoverInterruptedTurnsMessage",
    "recoverInterruptedTurnsSubagentMessage",
    "removeAgentCreditsOnMerge",
    "responseStreamingMode",
    "restoreWorktreesOnResume",
    "reviewGuideInstructions",
    "reviewGuideModelSelection",
    "reviewGuidesEnabled",
    "secretProviders",
    "sidebarAutoSettleAfterDays",
    "sidebarAutoSettleKeepPullRequests",
    "sidebarAutoSettleOnMerge",
    "simlockDeviceHosts",
    "simlockDeviceHostsEnabled",
    "snoozeLimitedThreads",
    "sourceControlWriterModelSelection",
    "sourceControlWritingStyle",
    "speechPostProcessingModelSelection",
    "storageCleanup",
    "terminalHistoryLines",
    "terminalHistoryMegabytes",
    "terminalThreads",
    "textGenerationModelSelection",
    "threadAddressing",
    "threadTitleInstructions",
    "usageModelAliases",
    "usageModelFilter",
    "usagePriceOverrides",
    "worktreeArtifactsAfterDays",
    "worktreeCleanup",
    "worktreeSubmodules",
    KEYBINDINGS_SETTING_KEY,
    "sharedThemes",
  ] satisfies ReadonlyArray<keyof ServerSettings | typeof KEYBINDINGS_SETTING_KEY | "sharedThemes">,
  client: [
    // Routes agent work between providers, so it changes what the machines do.
    "loadBalancingEnabled",
    "loadBalancingWeights",
    // A person who is not the owner writes their circle part, so these stay with the owner: they
    // send keystrokes, load a URL or register push delivery on every client of the circle.
    "terminalKeyMappings",
    "browserCustomSearchUrl",
    "webPushEnabled",
  ],
};

const KNOWN_SETTINGS: Readonly<Record<SettingScope, ReadonlyArray<string>>> = {
  server: [...Object.keys(ServerSettingsSchema.fields), KEYBINDINGS_SETTING_KEY, "sharedThemes"],
  client: Object.keys(ClientSettingsSchema.fields),
};

describe("setting columns", () => {
  it("puts every known setting key in exactly one column", () => {
    for (const scope of ["server", "client"] as const) {
      const shared = new Set(SHARED_ONLY_SETTINGS[scope]);
      const columns = KNOWN_SETTINGS[scope].flatMap((key) => {
        const hits = [
          isMachineLocalSetting(scope, key) ? "machine-local" : null,
          isCircleSetting(scope, key) ? "circle" : null,
          shared.has(key) ? "shared-only" : null,
        ].filter((hit) => hit !== null);
        return hits.length === 1 ? [] : [{ scope, key, hits }];
      });
      expect(columns).toEqual([]);
      const known = new Set(KNOWN_SETTINGS[scope]);
      expect(SHARED_ONLY_SETTINGS[scope].filter((key) => !known.has(key))).toEqual([]);
    }
  });
});
