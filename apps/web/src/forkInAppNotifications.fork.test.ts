import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { inAppNotificationTimeout } from "./forkInAppNotifications.logic";

describe("inAppNotificationTimeout", () => {
  it("keeps the toast default of 5 seconds for both kinds", () => {
    expect(inAppNotificationTimeout("completion", DEFAULT_CLIENT_SETTINGS)).toBe(5000);
    expect(inAppNotificationTimeout("attention", DEFAULT_CLIENT_SETTINGS)).toBe(5000);
  });

  it("uses the chosen seconds, hides completions, and keeps attention open", () => {
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      inAppNotificationSeconds: 12,
      inAppNotificationCompletions: false,
      inAppNotificationAttentionStays: true,
    };
    expect(inAppNotificationTimeout("completion", settings)).toBeNull();
    expect(inAppNotificationTimeout("attention", settings)).toBe(0);
    expect(
      inAppNotificationTimeout("attention", {
        ...settings,
        inAppNotificationAttentionStays: false,
      }),
    ).toBe(12000);
  });
});
