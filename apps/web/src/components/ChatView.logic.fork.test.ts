import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  presentConnectionState,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { scheduleEnvironmentReconnectWarning } from "./ChatView.logic";
import { restartReconnectWarningDelayMs } from "./chat/forkReconnectWarningGrace";

// Fork: `restartReconnectWarningGrace` (chat/forkReconnectWarningGrace.ts).

function scheduleWarning(enabled: boolean, msSincePageLoad: number) {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const showWarning = vi.fn();
  const cancel = scheduleEnvironmentReconnectWarning(
    showWarning,
    restartReconnectWarningDelayMs(enabled, msSincePageLoad),
  );
  return { showWarning, cancel };
}

describe("reconnect warning after a restart", () => {
  it("waits until 45 seconds after the page load, then warns", () => {
    const { showWarning } = scheduleWarning(true, 1_000);
    vi.advanceTimersByTime(43_999);
    expect(showWarning).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(showWarning).toHaveBeenCalledOnce();
  });

  it("never warns when the connection comes back in time", () => {
    const { showWarning, cancel } = scheduleWarning(true, 1_000);
    vi.advanceTimersByTime(30_000);
    cancel();
    vi.advanceTimersByTime(60_000);
    expect(showWarning).not.toHaveBeenCalled();
  });

  it("keeps the upstream wait for a later reconnect and with the setting off", () => {
    for (const [enabled, msSincePageLoad] of [
      [true, 120_000],
      [false, 1_000],
    ] as const) {
      const { showWarning } = scheduleWarning(enabled, msSincePageLoad);
      vi.advanceTimersByTime(1_999);
      expect(showWarning).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(showWarning).toHaveBeenCalledOnce();
    }
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
