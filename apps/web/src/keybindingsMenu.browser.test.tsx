import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../test/render";
import { ForkContextMenuHost } from "./components/ForkContextMenuHost";
import { ShortcutTrigger } from "./components/focusLevels/ShortcutHint";
import { Tooltip, TooltipPopup } from "./components/ui/tooltip";
import { installContextMenuKeybindings } from "./keybindingsMenu";

it("a control's right-click menu lists its rows and settings before Keybindings", async () => {
  const run = vi.fn();
  const openKeybindings = vi.fn();
  installContextMenuKeybindings(openKeybindings);
  await using screen = await render(
    <>
      <ForkContextMenuHost />
      <Tooltip>
        <ShortcutTrigger
          command="chat.newTerminal"
          rows={[{ command: "chat.newTerminalLocal", name: "In current project", run }]}
          menu={[{ settings: "terminal-threads" }]}
          render={<button type="button" />}
        >
          New terminal thread
        </ShortcutTrigger>
        <TooltipPopup>New terminal thread</TooltipPopup>
      </Tooltip>
    </>,
  );

  const trigger = screen.getByRole("button", { name: "New terminal thread" });
  await userEvent.click(trigger, { button: "right" });
  const items = page.getByRole("menuitem");
  await expect.element(items.nth(2)).toBeVisible();
  const labels = [0, 1, 2].map((index) => items.nth(index).element().textContent);
  expect(labels[0]).toMatch(/^In current project/);
  expect(labels[1]).toMatch(/^Settings: Terminal threads/);
  expect(labels[2]).toMatch(/^Keybindings…/);

  await userEvent.click(page.getByRole("menuitem", { name: /In current project/ }));
  expect(run).toHaveBeenCalledTimes(1);

  // Focus returns to the trigger a frame after the menu closes; the key must reach the trigger.
  await expect.element(trigger).toHaveFocus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await expect.element(page.getByRole("menuitem", { name: /Keybindings/ })).toBeVisible();
  await userEvent.click(page.getByRole("menuitem", { name: /Keybindings/ }));
  expect(openKeybindings).toHaveBeenCalledWith("chat.newTerminal");
});
