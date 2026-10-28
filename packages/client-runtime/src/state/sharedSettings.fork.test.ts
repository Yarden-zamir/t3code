import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { splitSharedServerPatch } from "./sharedSettings.ts";

describe("fork shared settings", () => {
  // Fork: thread card layouts sync to every machine of the machine map.
  it("shares the thread card layouts", () => {
    const { sharedPatch } = splitSharedServerPatch({
      threadCardLayouts: DEFAULT_SERVER_SETTINGS.threadCardLayouts,
    });
    expect(sharedPatch).toHaveProperty("threadCardLayouts");
  });
});
