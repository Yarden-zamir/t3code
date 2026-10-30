import type { ContextMenuItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withKeybindsEntry } from "./keybindingsMenu";

describe("withKeybindsEntry", () => {
  it("leaves a menu without bindable items unchanged", () => {
    const items: ContextMenuItem[] = [{ id: "copy", label: "Copy" }];
    expect(withKeybindsEntry(items).items).toBe(items);
  });

  it("adds one Keybinds item that maps back to the command of a single bindable item", () => {
    const menu = withKeybindsEntry([
      { id: "close", label: "Close", keybindingCommand: "rightPanel.close" },
      { id: "close-all", label: "Close all" },
    ]);
    const entry = menu.items.at(-1);
    expect(entry).toMatchObject({ label: "Keybinds: Close", separatorBefore: true });
    expect(menu.commandById.get(entry?.id ?? "")).toBe("rightPanel.close");
    expect(menu.commandById.has("close")).toBe(false);
  });

  it("lists each command once, also from submenus, in a Keybinds submenu", () => {
    const menu = withKeybindsEntry([
      { id: "pin", label: "Pin thread", keybindingCommand: "thread.pin" },
      {
        id: "more",
        label: "More",
        children: [
          { id: "rename", label: "Rename thread", keybindingCommand: "thread.rename" },
          { id: "pin-again", label: "Pin again", keybindingCommand: "thread.pin" },
        ],
      },
    ]);
    const children = menu.items.at(-1)?.children ?? [];
    expect(children.map((child) => child.label)).toEqual(["Pin thread", "Rename thread"]);
    expect(children.map((child) => menu.commandById.get(child.id))).toEqual([
      "thread.pin",
      "thread.rename",
    ]);
  });
});
