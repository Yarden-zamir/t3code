import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { registerCommandRunner } from "../../shortcuts/commandRunner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TooltipRows } from "./ShortcutHint";

it("a command row runs its command on click and a text row stays text", async () => {
  const run = vi.fn();
  await using screen = await render(
    <Tooltip>
      <TooltipTrigger render={<button type="button" />}>New thread</TooltipTrigger>
      <TooltipPopup>
        New thread
        <TooltipRows
          rows={[
            { command: "chat.newLocal", name: "In current project (Shift+click)", run },
            { text: "Also in the command palette" },
          ]}
        />
      </TooltipPopup>
    </Tooltip>,
  );
  using _runner = { [Symbol.dispose]: registerCommandRunner(() => true) };

  await userEvent.hover(screen.getByRole("button", { name: "New thread" }));
  const row = screen.getByRole("button", { name: /In current project/ });
  await expect.element(row).toBeVisible();
  await expect.element(row).toHaveAttribute("data-keybinding-command", "chat.newLocal");
  await expect.element(screen.getByText("Also in the command palette")).toBeVisible();
  expect(screen.getByRole("button", { name: /Also in the command palette/ }).query()).toBeNull();

  await userEvent.click(row);
  expect(run).toHaveBeenCalledTimes(1);
});
