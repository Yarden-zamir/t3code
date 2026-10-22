import { describe, expect, it } from "vite-plus/test";

import { getSettingsSearchTargetScope, searchSettings } from "./settingsSearch";

describe("searchSettings", () => {
  it.each(["machine map", "join code", "portal"])("finds the fork machine map for %s", (query) => {
    expect(searchSettings(query)).toContainEqual(
      expect.objectContaining({ id: "machine-map", to: "/settings/machines" }),
    );
    expect(getSettingsSearchTargetScope("machine-map")?.scope).toBeNull();
  });
});
