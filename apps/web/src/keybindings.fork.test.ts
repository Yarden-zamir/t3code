import { assert, describe, it } from "vite-plus/test";

import type { KeybindingShortcut, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  isTerminalAppShortcut,
  resolveShortcutCommand,
  type ShortcutEventLike,
} from "./keybindings";

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

describe("settings.find", () => {
  const find = event({ key: "f", metaKey: true });
  const resolve = (context: Record<string, boolean>) =>
    resolveShortcutCommand(find, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel", context });

  it("takes mod+f only on a Settings page", () => {
    assert.strictEqual(resolve({ settingsPageOpen: true }), "settings.find");
    assert.strictEqual(resolve({}), "chat.find");
    assert.strictEqual(resolve({ sidebarFocus: true }), "sidebar.search");
    assert.strictEqual(resolve({ terminalFocus: true }), null);
  });
});
