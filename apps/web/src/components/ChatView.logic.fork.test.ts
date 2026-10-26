import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  presentConnectionState,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import { ENVIRONMENT_RECONNECT_WARNING_GRACE_MS } from "./ChatView.logic";
import { reconnectWarningDelayMs } from "./chat/forkReconnectWarningGrace";

// Fork: `restartReconnectWarningGrace` (chat/forkReconnectWarningGrace.ts).

describe("reconnect warning after a restart", () => {
  it("waits until 45 seconds after the page load", () => {
    expect(reconnectWarningDelayMs(true, 1_000)).toBe(44_000);
  });

  it("keeps the upstream wait for a later reconnect and with the setting off", () => {
    expect(reconnectWarningDelayMs(true, 120_000)).toBe(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);
    expect(reconnectWarningDelayMs(false, 1_000)).toBe(ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);
  });

  it("does not wait for a refused sign-in", () => {
    // The composer waits only while the phase is connecting or reconnecting.
    const refused = presentConnectionState({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "blocked",
      attempt: 1,
      lastFailure: new ConnectionBlockedError({
        reason: "authentication",
        detail: "Authentication required.",
      }),
    });
    expect(refused.phase).toBe("error");
  });
});
