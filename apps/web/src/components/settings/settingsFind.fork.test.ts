import { describe, expect, it } from "vite-plus/test";

import { isSettingsFindPage, settingsFindMatch } from "./settingsFind";

describe("settingsFindMatch", () => {
  it("matches only the rows of the open page", () => {
    // "shortcuts" names rows on Keybindings and on Terminal.
    const keybindings = settingsFindMatch("shortcuts", "/settings/keybindings");
    expect(keybindings.matched).toContain("tooltip-shortcuts");
    expect(keybindings.matched).not.toContain("terminal-app-shortcuts-first");
    expect([...keybindings.matched].every((id) => keybindings.pageAnchors.has(id))).toBe(true);
    expect(settingsFindMatch("shortcuts", "/settings/terminal").matched).toContain(
      "terminal-app-shortcuts-first",
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

  it("does not match every row through the page label", () => {
    const match = settingsFindMatch("gener", "/settings/general");
    expect(match.matched.size).toBeLessThan(match.pageAnchors.size);
  });
});

describe("isSettingsFindPage", () => {
  it("filters pages of setting rows and leaves list pages to the settings search", () => {
    expect(isSettingsFindPage("/settings/general")).toBe(true);
    expect(isSettingsFindPage("/settings/fork")).toBe(true);
    expect(isSettingsFindPage("/settings/archived")).toBe(false);
    expect(isSettingsFindPage("/settings/open-source-licenses")).toBe(false);
  });
});
