import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { clientSettingsPatchFromDesired } from "./clientSettings.logic";

describe("clientSettingsPatchFromDesired", () => {
  it("writes nothing when the desired values are already current", () => {
    const current = { ...DEFAULT_CLIENT_SETTINGS, chatWidth: "wide" as const };
    const result = clientSettingsPatchFromDesired({ chatWidth: "wide" }, current);
    expect(result).toEqual({ patch: {}, skipped: [] });
  });

  it("keeps changed values and skips unknown keys and invalid values", () => {
    const result = clientSettingsPatchFromDesired(
      { chatWidth: "full", notAClientSetting: true, inAppNotificationsEnabled: "yes" },
      DEFAULT_CLIENT_SETTINGS,
    );
    expect(result.patch).toEqual({ chatWidth: "full" });
    expect(result.skipped).toEqual(["notAClientSetting", "inAppNotificationsEnabled"]);
  });
});
