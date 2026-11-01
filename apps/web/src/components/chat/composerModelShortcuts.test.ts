import { describe, expect, it } from "vite-plus/test";

import { composerTriggerCommands } from "./composerModelShortcuts";

describe("composerTriggerCommands", () => {
  it.each([
    [undefined, ["modelPicker.toggle"]],
    ["composer.effort", ["modelPicker.toggle", "composer.effort"]],
    ["composer.effort composer.mode", ["modelPicker.toggle", "composer.effort", "composer.mode"]],
  ])("lists the model key first, then the keys the trigger owns (%s)", (owned, expected) => {
    expect(composerTriggerCommands(owned).map((entry) => entry.command)).toEqual(expected);
  });

  it("throws for a command it has no tooltip name for", () => {
    expect(() => composerTriggerCommands("composer.effort composer.branch")).toThrow(
      "composer.branch",
    );
  });
});
