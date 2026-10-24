import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { showContextMenuFallback } from "./contextMenuFallback";

const ITEMS = [
  { id: "one", label: "One" },
  { id: "two", label: "Two", disabled: true },
  { id: "three", label: "Three" },
] as const;

function focusInvoker(): HTMLTextAreaElement {
  const invoker = document.createElement("textarea");
  document.body.appendChild(invoker);
  invoker.focus();
  return invoker;
}

describe("showContextMenuFallback keyboard", () => {
  it("takes focus, and Escape closes it and gives focus back", async () => {
    const invoker = focusInvoker();
    const selection = showContextMenuFallback(ITEMS, { x: 10, y: 10 });
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();

    await userEvent.keyboard("{Escape}");

    await expect(selection).resolves.toBeNull();
    expect(document.activeElement).toBe(invoker);
    expect(invoker.value).toBe("");
    invoker.remove();
  });

  it("moves with the arrow keys over enabled items and picks one with Enter", async () => {
    const invoker = focusInvoker();
    const selection = showContextMenuFallback(ITEMS, { x: 10, y: 10 });
    expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();

    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Three");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("One");
    await userEvent.keyboard("{ArrowUp}{Enter}");

    await expect(selection).resolves.toBe("three");
    invoker.remove();
  });

  it("opens a submenu with ArrowRight and closes it with ArrowLeft", async () => {
    const invoker = focusInvoker();
    const selection = showContextMenuFallback(
      [{ id: "snooze", label: "Snooze", children: [{ id: "hour", label: "1 hour" }] }],
      { x: 10, y: 10 },
    );

    await userEvent.keyboard("{ArrowDown}{ArrowRight}");
    expect(document.activeElement?.textContent).toBe("1 hour");
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement?.textContent).toBe("Snooze");
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    await userEvent.keyboard("{ArrowRight}{Enter}");

    await expect(selection).resolves.toBe("hour");
    invoker.remove();
  });
});
