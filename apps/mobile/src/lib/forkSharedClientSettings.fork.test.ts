import { describe, expect, it } from "vite-plus/test";

import { mobilePreferencesFromSharedClientSettings } from "./forkSharedClientSettings";

describe("mobilePreferencesFromSharedClientSettings (MM-416)", () => {
  it("takes the client settings that the app has, under its own names", () => {
    expect(
      mobilePreferencesFromSharedClientSettings({
        followUpBehavior: "queue",
        sidebarWorkingShelfEnabled: false,
        chatWidth: "wide",
      }),
    ).toEqual({ followUpBehavior: "queue", workingShelfEnabled: false });
  });

  it("leaves out a value that the client settings schema refuses", () => {
    expect(
      mobilePreferencesFromSharedClientSettings({
        planModeEnabled: "yes",
        mathRenderingEnabled: true,
      }),
    ).toEqual({ mathRenderingEnabled: true });
  });
});
