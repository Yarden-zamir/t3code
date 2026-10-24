import { afterEach, describe, expect, it } from "vite-plus/test";

import { isTerminalFocused, isTerminalThreadShellKey } from "./terminalFocus";

class MockHTMLElement {
  isConnected = false;
  terminalOwner: string | null = null;
  readonly dataset: { terminalOwner?: string } = {};

  closest(selector: string): MockHTMLElement | null {
    if (!this.isConnected) {
      return null;
    }
    if (selector === "[data-terminal-owner]" && this.terminalOwner !== null) {
      return this;
    }
    return null;
  }
}

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }

  if (originalHTMLElement === undefined) {
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

const focusTerminal = (owner: "drawer" | "terminal-thread") => {
  const textarea = new MockHTMLElement();
  textarea.isConnected = true;
  textarea.terminalOwner = owner;
  textarea.dataset.terminalOwner = owner;
  globalThis.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
  globalThis.document = { activeElement: textarea } as unknown as Document;
};

describe("isTerminalFocused", () => {
  it("leaves Cmd chords of a terminal thread's main terminal to the app", () => {
    focusTerminal("terminal-thread");
    expect(isTerminalFocused({ metaKey: true })).toBe(false);
    expect(isTerminalFocused({ metaKey: false })).toBe(true);
    focusTerminal("drawer");
    expect(isTerminalFocused({ metaKey: true })).toBe(true);
  });
});

describe("isTerminalThreadShellKey", () => {
  const ctrl = { ctrlKey: true, metaKey: false };
  const cmd = { ctrlKey: false, metaKey: true };

  it("gives Ctrl chords of the main terminal of a terminal thread to the shell", () => {
    focusTerminal("terminal-thread");
    expect(isTerminalThreadShellKey(ctrl)).toBe(true);
    expect(isTerminalThreadShellKey(cmd)).toBe(false);
  });

  it("keeps Ctrl chords of the drawer for its pane shortcuts", () => {
    focusTerminal("drawer");
    expect(isTerminalThreadShellKey(ctrl)).toBe(false);
  });
});
