import { assert, describe, it } from "vite-plus/test";

import type { KeybindingShortcut, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { isTerminalAppShortcut, type ShortcutEventLike } from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

function modShortcut(key: string): KeybindingShortcut {
  return { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: true };
}

const BINDINGS: ResolvedKeybindingsConfig = [
  { shortcut: modShortcut("b"), command: "sidebar.toggle" },
  {
    shortcut: modShortcut("k"),
    command: "commandPalette.toggle",
    whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
  },
];

describe("isTerminalAppShortcut", () => {
  const focused = { platform: "MacIntel", context: { terminalFocus: true } };

  it("yields keys bound to an app command only when the setting is on", () => {
    const sidebar = event({ key: "b", metaKey: true });
    assert.isTrue(
      isTerminalAppShortcut(sidebar, BINDINGS, { ...focused, appShortcutsFirst: true }),
    );
    assert.isFalse(
      isTerminalAppShortcut(sidebar, BINDINGS, { ...focused, appShortcutsFirst: false }),
    );
  });

  it("keeps unbound keys and bindings excluded by terminalFocus for the shell", () => {
    const options = { ...focused, appShortcutsFirst: true };
    assert.isFalse(isTerminalAppShortcut(event({ key: "x", ctrlKey: true }), BINDINGS, options));
    assert.isFalse(isTerminalAppShortcut(event({ key: "k", metaKey: true }), BINDINGS, options));
  });
});
