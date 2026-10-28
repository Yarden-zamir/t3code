import { ClientSettingsPatch, type SettingValues } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { Preferences } from "../persistence/mobile-preferences";

const isClientSettingsPatch = Schema.is(ClientSettingsPatch);

/**
 * Fork, MM-416: the shared client settings that the app has as its own preferences. The other
 * client settings belong to the web and desktop UI, so the app does not take them. A value that
 * the client settings schema refuses is left out.
 */
export function mobilePreferencesFromSharedClientSettings(
  changed: SettingValues,
): Partial<Preferences> {
  const valid = Object.fromEntries(
    Object.entries(changed).filter(([key, value]) => isClientSettingsPatch({ [key]: value })),
  );
  if (!isClientSettingsPatch(valid)) {
    throw new Error("Each shared client setting passed its check, but the patch did not.");
  }
  return {
    ...(valid.followUpBehavior === undefined ? {} : { followUpBehavior: valid.followUpBehavior }),
    ...(valid.mathRenderingEnabled === undefined
      ? {}
      : { mathRenderingEnabled: valid.mathRenderingEnabled }),
    ...(valid.planModeEnabled === undefined ? {} : { planModeEnabled: valid.planModeEnabled }),
    ...(valid.sidebarWorkingShelfEnabled === undefined
      ? {}
      : { workingShelfEnabled: valid.sidebarWorkingShelfEnabled }),
  };
}
