import type { ContextMenuItem, KeybindingShortcut } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pickItemMenuCommand, withShortcuts } from "./keybindingsMenu";

const modK: KeybindingShortcut = {
  key: "k",
  modKey: true,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

describe("withShortcuts", () => {
  it("adds the key of each bound command, also in submenus, and nothing for the rest", () => {
    const items = withShortcuts(
      [
        { id: "rename", label: "Rename", keybindingCommand: "thread.rename" },
        { id: "pin", label: "Pin", keybindingCommand: "thread.pin" },
        { id: "copy", label: "Copy" },
        {
          id: "more",
          label: "More",
          children: [{ id: "archive", label: "Archive", keybindingCommand: "thread.archive" }],
        },
      ],
      (command) => (command === "thread.pin" ? null : modK),
    );
    expect(items.map((item) => item.shortcut)).toEqual([modK, undefined, undefined, undefined]);
    expect(items[3]?.children?.[0]?.shortcut).toEqual(modK);
  });
});

describe("pickItemMenuCommand", () => {
  const show = (picked: string | null) => (_items: readonly ContextMenuItem[]) =>
    Promise.resolve(picked);

  it("returns the item's command when Keybinds is picked, and null when dismissed", async () => {
    const position = { x: 0, y: 0 };
    expect(await pickItemMenuCommand("thread.rename", position, show("keybinds"))).toBe(
      "thread.rename",
    );
    expect(await pickItemMenuCommand("thread.rename", position, show(null))).toBeNull();
  });
});
