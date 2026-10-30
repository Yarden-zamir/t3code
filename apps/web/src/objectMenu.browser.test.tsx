import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../test/render";
import { ForkContextMenuHost } from "./components/ForkContextMenuHost";
import { __setClientSettingsForTests } from "./hooks/useSettings";
import { installContextMenuKeybindings } from "./keybindingsMenu";
import { installObjectMenus, objectMenuActionsProps, objectMenuProps } from "./objectMenu";

function setup() {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  installContextMenuKeybindings(vi.fn());
  installObjectMenus();
  const pin = vi.fn();
  const nested = vi.fn();
  return { pin, nested };
}

describe("object menus", () => {
  it("lists the controls of the object itself and its copy entries", async () => {
    const { pin, nested } = setup();
    await using _screen = await render(
      <>
        <ForkContextMenuHost />
        <div {...objectMenuProps([{ label: "Copy link", value: "https://example.com" }])}>
          <p>Message text</p>
          <div {...objectMenuActionsProps}>
            <button type="button" onClick={pin}>
              Pin message
            </button>
            <button type="button" aria-haspopup="menu">
              More
            </button>
            <div inert>
              <button type="button">Locked</button>
            </div>
          </div>
          <div {...objectMenuProps()}>
            <span>Code</span>
            <div {...objectMenuActionsProps}>
              <button type="button" onClick={nested}>
                Copy code
              </button>
            </div>
          </div>
        </div>
      </>,
    );

    await userEvent.click(page.getByText("Message text"), { button: "right" });
    const items = page.getByRole("menuitem");
    await expect.element(items.first()).toBeVisible();
    expect(items.elements().map((item) => item.textContent?.trim())).toEqual([
      "Pin message",
      "Copy link",
    ]);
    await userEvent.click(page.getByRole("menuitem", { name: "Pin message" }));
    expect(pin).toHaveBeenCalledTimes(1);

    await userEvent.click(page.getByText("Code"), { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Copy code" }));
    expect(nested).toHaveBeenCalledTimes(1);
  });

  it("leaves selected text to the browser menu", async () => {
    setup();
    await using _screen = await render(
      <>
        <ForkContextMenuHost />
        <div {...objectMenuProps()}>
          <p>Selected words</p>
          <div {...objectMenuActionsProps}>
            <button type="button">Pin message</button>
          </div>
        </div>
      </>,
    );
    const text = page.getByText("Selected words").element();
    window.getSelection()?.selectAllChildren(text);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    text.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  });
});
