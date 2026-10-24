import { describe, expect, it } from "vite-plus/test";

import {
  filterAvailableSettingsSearchItems,
  getSettingsSearchTargetScope,
  searchSettings,
} from "./settingsSearch";

describe("searchSettings", () => {
  it.each(["machine map", "join code", "portal"])("finds the fork machine map for %s", (query) => {
    expect(searchSettings(query)).toContainEqual(
      expect.objectContaining({ id: "machine-map", to: "/settings/machines" }),
    );
    expect(getSettingsSearchTargetScope("machine-map")?.scope).toBeNull();
  });

  it("finds linked environments on a remote host without local maintenance access", () => {
    const availability = {
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      localEnvironmentDisabled: true,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    const results = (hasPeerLinkHost: boolean) =>
      searchSettings(
        "linked environments",
        filterAvailableSettingsSearchItems({ ...availability, hasPeerLinkHost }),
      );
    expect(results(false).map((item) => item.id)).not.toContain("linked-environments");
    expect(results(true)).toContainEqual(
      expect.objectContaining({
        id: "linked-environments",
        to: "/settings/connections",
        targetId: "linked-environments",
      }),
    );
  });
});
