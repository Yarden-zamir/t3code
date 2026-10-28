import { describe, expect, it } from "vite-plus/test";

import { sharedSettingsToApply } from "./sharedClientSettings.ts";

describe("sharedSettingsToApply (MM-416)", () => {
  it("applies every shared value on a device that applied none", () => {
    const plan = sharedSettingsToApply({ planModeEnabled: true, chatWidth: "wide" }, {});
    expect(plan.changed).toEqual({ planModeEnabled: true, chatWidth: "wide" });
  });

  it("keeps a change on the device until the shared value of that key changes", () => {
    const first = sharedSettingsToApply({ planModeEnabled: true, chatWidth: "wide" }, {});
    // The device turned plan mode off; a push with the same shared values changes nothing.
    expect(
      sharedSettingsToApply({ planModeEnabled: true, chatWidth: "wide" }, first.applied),
    ).toEqual({ changed: {}, applied: first.applied });
    // Another key changed: only that key applies, so plan mode stays off.
    const next = sharedSettingsToApply({ planModeEnabled: true, chatWidth: "full" }, first.applied);
    expect(next.changed).toEqual({ chatWidth: "full" });
  });

  it("forgets a key without a shared value, so sharing it again applies it", () => {
    const first = sharedSettingsToApply({ planModeEnabled: true }, {});
    const stopped = sharedSettingsToApply({}, first.applied);
    expect(stopped).toEqual({ changed: {}, applied: {} });
    expect(sharedSettingsToApply({ planModeEnabled: true }, stopped.applied).changed).toEqual({
      planModeEnabled: true,
    });
  });
});
