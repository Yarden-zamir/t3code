import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { requestForkContextMenu } from "../forkContextMenu";
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

function setup(richContextMenu: boolean) {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, richContextMenu });
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
  it("leaves menus to the caller while the setting is off", async () => {
    setup(false);
    await using _screen = await render(<ForkContextMenuHost />);
    expect(requestForkContextMenu(ITEMS)).toBeUndefined();
  });

  it("picks an item with the arrow keys and Enter, then gives focus back", async () => {
    setup(true);
    await using _screen = await render(<ForkContextMenuHost />);
    const invoker = focusInvoker();
    const selection = openMenu();

    await expect.element(page.getByRole("menu")).toBeVisible();
    await expect.element(page.getByText("Thread")).toBeVisible();
    // Base UI keeps disabled items reachable, as ARIA menus allow, and skips nothing.
    // Base UI keeps disabled items reachable, as ARIA menus allow.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");

    await expect(selection).resolves.toBe("delete");
    expect(document.activeElement).toBe(invoker);
    invoker.remove();
  });

  it("resolves null on Escape", async () => {
    setup(true);
    await using _screen = await render(<ForkContextMenuHost />);
    const selection = openMenu();
    await expect.element(page.getByRole("menu")).toBeVisible();

    await userEvent.keyboard("{Escape}");

    await expect(selection).resolves.toBeNull();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  });

  it("picks a check item in a submenu", async () => {
    setup(true);
    await using _screen = await render(<ForkContextMenuHost />);
    const selection = openMenu();

    await expect.element(page.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowRight}");
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Tab two" }));

    await expect(selection).resolves.toBe("tab:two");
  });

  it("keeps the focus that the caller moves after a pick", async () => {
    setup(true);
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
});
