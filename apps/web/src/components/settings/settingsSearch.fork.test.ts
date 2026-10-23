import { describe, expect, it } from "vite-plus/test";

import { searchSettings } from "./settingsSearch";

describe("terminal settings search", () => {
  it("finds the terminal font on Settings > Terminal, not in Appearance", () => {
    expect(searchSettings("terminal font")[0]).toMatchObject({
      id: "terminal-font",
      to: "/settings/terminal",
    });
  });
});
