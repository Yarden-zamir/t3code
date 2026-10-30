import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { isContextMenuOpen } from "../contextMenuFallback";
import { requestForkContextMenu } from "../forkContextMenu";
import { installContextMenuKeybindings } from "../keybindingsMenu";
import { readLocalApi } from "../localApi";
import { __setClientSettingsForTests } from "../hooks/useSettings";
import { render } from "../../test/render";
import { ForkContextMenuHost } from "./ForkContextMenuHost";

const ITEMS = [
  { id: "group", label: "Thread", header: true },
  { id: "rename", label: "Rename", icon: "pencil" },
  { id: "pin", label: "Pin", disabled: true },
  {
    id: "move",
    label: "Move to",
    children: [
      { id: "tab:one", label: "Tab one", checked: true },
      { id: "tab:two", label: "Tab two", checked: false },
    ],
  },
  { id: "delete", label: "Delete", destructive: true, separatorBefore: true },
];

const BINDABLE_ITEMS = [
  { id: "rename", label: "Rename", keybindingCommand: "thread.rename" as const },
  { id: "pin", label: "Pin", disabled: true, keybindingCommand: "thread.pin" as const },
];

function setup() {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const openKeybindings = vi.fn();
  installContextMenuKeybindings(openKeybindings);
  return { openKeybindings };
}

function focusInvoker(): HTMLButtonElement {
  const invoker = document.createElement("button");
  invoker.textContent = "invoker";
  document.body.appendChild(invoker);
  invoker.focus();
  return invoker;
}

function openMenu() {
  const selection = requestForkContextMenu(ITEMS, { x: 300, y: 300 });
  if (!selection) throw new Error("The app menu did not open.");
  return selection;
}

describe("ForkContextMenuHost", () => {
  it("leaves menus to the caller until the host mounts", () => {
    setup();
    expect(requestForkContextMenu(ITEMS)).toBeUndefined();
  });

  it("opens Keybindings for the command of a right-clicked item, also a disabled one", async () => {
    const { openKeybindings } = setup();
    await using _screen = await render(<ForkContextMenuHost />);
    const selection = requestForkContextMenu(BINDABLE_ITEMS, { x: 300, y: 300 });

    await userEvent.click(page.getByRole("menuitem", { name: /^Pin/ }), {
      button: "right",
      // A disabled item ignores the pointer; the click lands on the popup under it.
      force: true,
    });
    // The item menu opens nested, so the menu of the item stays open, also after Escape.
    await expect.element(page.getByRole("menuitem", { name: "Keybindings…" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("menuitem", { name: "Keybindings…" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("menuitem", { name: /^Rename/ })).toBeVisible();

    await userEvent.click(page.getByRole("menuitem", { name: /^Pin/ }), {
      button: "right",
      force: true,
    });
    await userEvent.click(page.getByRole("menuitem", { name: "Keybindings…" }));

    await expect(selection).resolves.toBeNull();
    expect(openKeybindings).toHaveBeenCalledWith("thread.pin");
  });

  it("opens the item menu from the key and ignores the contextmenu event that follows", async () => {
    setup();
    await using _screen = await render(<ForkContextMenuHost />);
    void requestForkContextMenu(BINDABLE_ITEMS, { x: 300, y: 300 });
    await expect.element(page.getByRole("menu")).toBeVisible();

    await userEvent.keyboard("{ArrowDown}{ContextMenu}");
    await expect.element(page.getByRole("menuitem", { name: "Keybindings…" })).toBeVisible();

    // Windows sends `contextmenu` after the key up, to the element that has focus by then.
    const row = document.createElement("button");
    document.body.appendChild(row);
    const rowMenu = vi.fn();
    row.addEventListener("contextmenu", rowMenu);
    const afterKey = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    row.dispatchEvent(afterKey);
    expect(afterKey.defaultPrevented).toBe(true);
    expect(rowMenu).not.toHaveBeenCalled();
    await expect.element(page.getByRole("menuitem", { name: "Keybindings…" })).toBeVisible();

    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(rowMenu).toHaveBeenCalledTimes(1);
    row.remove();
  });

  it("closes the item menu alone on Escape and runs its entry on Enter", async () => {
    const { openKeybindings } = setup();
    await using _screen = await render(<ForkContextMenuHost />);
    const selection = requestForkContextMenu(BINDABLE_ITEMS, { x: 300, y: 300 });
    await expect.element(page.getByRole("menu")).toBeVisible();
    const rename = page.getByRole("menuitem", { name: /^Rename/ });

    await userEvent.keyboard("{ArrowDown}{Shift>}{F10}{/Shift}");
    await expect.element(page.getByRole("menuitem", { name: "Keybindings…" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("menuitem", { name: "Keybindings…" }))
      .not.toBeInTheDocument();
    await expect.element(rename).toHaveFocus();

    await userEvent.keyboard("{Shift>}{F10}{/Shift}{Enter}");
    await expect(selection).resolves.toBeNull();
    expect(openKeybindings).toHaveBeenCalledWith("thread.rename");
  });

  it("picks an item with the arrow keys and Enter, then gives focus back", async () => {
    setup();
    await using _screen = await render(<ForkContextMenuHost />);
    const invoker = focusInvoker();
    const selection = openMenu();

    await expect.element(page.getByRole("menu")).toBeVisible();
    await expect.element(page.getByText("Thread")).toBeVisible();
    // Base UI keeps disabled items reachable, as ARIA menus allow.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");

    await expect(selection).resolves.toBe("delete");
    expect(document.activeElement).toBe(invoker);
    invoker.remove();
  });

  it("resolves null on Escape", async () => {
    setup();
    await using _screen = await render(<ForkContextMenuHost />);
    const selection = openMenu();
    await expect.element(page.getByRole("menu")).toBeVisible();

    await userEvent.keyboard("{Escape}");

    await expect(selection).resolves.toBeNull();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  });

  it("picks a check item in a submenu", async () => {
    setup();
    await using _screen = await render(<ForkContextMenuHost />);
    const selection = openMenu();

    await expect.element(page.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowRight}");
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Tab two" }));

    await expect(selection).resolves.toBe("tab:two");
  });

  it("keeps the focus that the caller moves after a pick", async () => {
    setup();
    await using _screen = await render(<ForkContextMenuHost />);
    const invoker = focusInvoker();
    const field = document.createElement("input");
    document.body.appendChild(field);
    const renamed = openMenu().then((id) => {
      field.focus();
      return id;
    });

    await userEvent.click(page.getByRole("menuitem", { name: "Rename" }));

    await expect(renamed).resolves.toBe("rename");
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(field);
    invoker.remove();
    field.remove();
  });

  it("takes the menus of the local API, which close() dismisses", async () => {
    setup();
    await using _screen = await render(<ForkContextMenuHost />);
    const api = readLocalApi();
    if (!api) throw new Error("No local API.");
    const selection = api.contextMenu.show(ITEMS, { x: 20, y: 20 });

    await expect.element(page.getByRole("menu")).toBeVisible();
    expect(isContextMenuOpen()).toBe(true);
    await api.contextMenu.close();

    await expect(selection).resolves.toBeNull();
    expect(isContextMenuOpen()).toBe(false);
  });
});
