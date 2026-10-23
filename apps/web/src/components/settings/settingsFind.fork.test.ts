import { describe, expect, it } from "vite-plus/test";

import { settingsFindMatch } from "./settingsFind";

describe("settingsFindMatch", () => {
  it("matches only the rows of the open page", () => {
    const match = settingsFindMatch("terminal", "/settings/keybindings");
    expect(match.matched).toContain("terminal-app-shortcuts-first");
    // Terminal close confirmation matches too, but lives on General.
    expect(match.matched).not.toContain("terminal-close-confirmation");
    expect(match.pageAnchors).not.toContain("terminal-close-confirmation");
    expect(settingsFindMatch("terminal", "/settings/general").matched).toContain(
      "terminal-close-confirmation",
    );
  });

  it("finds Fork page rows by the ids that their rows render", () => {
    const match = settingsFindMatch("keyboard focus levels", "/settings/fork");
    expect(match.matched).toContain("keyboard-focus-levels");
    expect(match.matched).not.toContain("fork-keyboard-focus-levels");
  });

  it("matches nothing for text that no row of the page has", () => {
    expect(settingsFindMatch("zzz-no-such-setting", "/settings/general").matched.size).toBe(0);
  });
});
