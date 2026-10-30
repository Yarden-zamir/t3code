import { describe, expect, it } from "vite-plus/test";

import { toElectronAccelerator } from "./electronAccelerator.ts";

const plain = { modKey: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

describe("toElectronAccelerator", () => {
  it("names keybinding keys and recorded snapshot keys the way Electron expects", () => {
    expect(toElectronAccelerator({ ...plain, key: "r", modKey: true, shiftKey: true })).toBe(
      "CommandOrControl+Shift+R",
    );
    expect(toElectronAccelerator({ ...plain, key: "arrowdown", altKey: true })).toBe("Alt+Down");
    expect(toElectronAccelerator({ ...plain, key: "ArrowDown", altKey: true })).toBe("Alt+Down");
    expect(toElectronAccelerator({ ...plain, key: " ", ctrlKey: true })).toBe("Control+Space");
  });
});
