/**
 * Fork: `restartReconnectWarningGrace`. After an update, the desktop app and the remote servers
 * restart at about the same time. A remote server then needs up to about 40 seconds before it
 * accepts a connection, so the composer showed "<server> is reconnecting" on each restart.
 *
 * The wait counts from the page load, not from the composer mount: the composer mounts again
 * for each thread, and a wait per mount would restart on each thread switch. Only connecting
 * and reconnecting servers wait (`useSystemComposerBanners`), so a refused sign-in or an
 * offline device still shows at once.
 *
 * Limit: 45 seconds covers the slowest restart in the desktop traces (38 seconds from app start
 * to connected, while the server restarted too). Revisit when a normal restart takes longer.
 */
const RESTART_RECONNECT_WARNING_GRACE_MS = 45_000;

/** The least wait before the reconnect warning, in milliseconds. 0 keeps the upstream wait. */
export function restartReconnectWarningDelayMs(
  enabled: boolean,
  msSincePageLoad: number = performance.now(),
): number {
  return enabled ? Math.max(0, RESTART_RECONNECT_WARNING_GRACE_MS - msSincePageLoad) : 0;
}
