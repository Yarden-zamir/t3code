import type { ClientSettings } from "@t3tools/contracts";

/** Fork: what an in-app thread notification tells. `attention` covers input, approval and failure. */
export type InAppNotificationKind = "completion" | "attention";

type InAppNotificationSettings = Pick<
  ClientSettings,
  "inAppNotificationSeconds" | "inAppNotificationCompletions" | "inAppNotificationAttentionStays"
>;

/** Fork: the toast `timeout` of an in-app thread notification, or null when it does not show. */
export function inAppNotificationTimeout(
  kind: InAppNotificationKind,
  settings: InAppNotificationSettings,
): number | null {
  if (kind === "completion" && !settings.inAppNotificationCompletions) return null;
  if (kind === "attention" && settings.inAppNotificationAttentionStays) return 0;
  return settings.inAppNotificationSeconds * 1000;
}
