import { isMacPlatform } from "@t3tools/shared/keybindings";
import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { installChatRouteCommands } from "./chatRouteCommands";

const CHAT_ROUTER = {
  state: {
    matches: [
      { routeId: "__root__", pathname: "/", params: {} },
      { routeId: "/_chat", pathname: "/", params: {} },
    ],
  },
} as unknown as AnyRouter;

const isMac = isMacPlatform(navigator.platform);

function press(key: string, modifiers: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    cancelable: true,
    bubbles: true,
    ...modifiers,
  });
  window.dispatchEvent(event);
  return event;
}

function focusTerminalThreadInput(): Disposable {
  const owner = document.createElement("div");
  owner.dataset.terminalOwner = "terminal-thread";
  const input = document.createElement("textarea");
  owner.append(input);
  document.body.append(owner);
  input.focus();
  return { [Symbol.dispose]: () => owner.remove() };
}

describe("chat route commands (fork terminal threads)", () => {
  it("leaves the terminal twin of new thread unclaimed while no server has terminal threads on", () => {
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(CHAT_ROUTER));

    const mod = isMac ? { metaKey: true } : { ctrlKey: true };
    expect(press("t", { ...mod, altKey: true }).defaultPrevented).toBe(false);
  });

  it.skipIf(isMac)("leaves a Ctrl chord in a terminal thread's main terminal to its shell", () => {
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(CHAT_ROUTER));

    expect(press("j", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    using _terminal = focusTerminalThreadInput();
    expect(press("j", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
  });
});
