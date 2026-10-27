import { ENVIRONMENT_RECONNECT_WARNING_GRACE_MS } from "../ChatView.logic";

/**
 * Fork: after an update, a remote server needs up to 40 seconds to accept a connection again.
 * The wait counts from page load, not composer mount, which repeats on each thread switch.
 * Only connecting and reconnecting servers wait; a refused sign-in or offline device shows at once.
 * Limit: 45 seconds covers the slowest traced restart (38 seconds). Revisit if one takes longer.
 */
const RESTART_RECONNECT_WARNING_GRACE_MS = 45_000;

/** The least wait before the reconnect warning, in milliseconds. 0 keeps the upstream wait. */
function restartReconnectWarningDelayMs(
  enabled: boolean,
  msSincePageLoad: number = performance.now(),
): number {
  return enabled ? Math.max(0, RESTART_RECONNECT_WARNING_GRACE_MS - msSincePageLoad) : 0;
}

/** The wait before the reconnect warning: upstream's grace, or longer right after a restart. */
export function reconnectWarningDelayMs(
  restartGraceEnabled: boolean,
  msSincePageLoad: number = performance.now(),
): number {
  return Math.max(
    ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
    restartReconnectWarningDelayMs(restartGraceEnabled, msSincePageLoad),
  );
}
