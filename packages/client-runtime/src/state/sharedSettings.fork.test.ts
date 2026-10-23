import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { pickSharedServerSettings } from "./sharedSettings.ts";

const restartCapabilities = { threadRestartContinuation: true };

describe("fork shared settings", () => {
  // Fork: thread card layouts sync to every machine of the machine map.
  it("shares the thread card layouts", () => {
    expect(pickSharedServerSettings(DEFAULT_SERVER_SETTINGS, restartCapabilities)).toHaveProperty(
      "threadCardLayouts",
    );
  });
});
