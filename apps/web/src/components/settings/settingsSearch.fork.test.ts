import { describe, expect, it } from "vite-plus/test";

import { forkSettingsSearchItems } from "./forkSettingsCatalog";
import { SETTINGS_SEARCH_ITEMS, searchSettings } from "./settingsSearch";

describe("terminal settings search", () => {
  it("finds the terminal font on Settings > Terminal, not in Appearance", () => {
    expect(searchSettings("terminal font")[0]).toMatchObject({
      id: "terminal-font",
      to: "/settings/terminal",
    });
  });
});

describe("fork page search copies", () => {
  it("copies a row of an upstream page, not a row that already lives on a fork page", () => {
    const copies = forkSettingsSearchItems(
      SETTINGS_SEARCH_ITEMS.filter(
        (item) => item.id === "terminal-history" || item.id === "web-push",
      ),
    );
    expect(copies.map((item) => item.targetId)).toEqual(["web-push"]);
  });
});
