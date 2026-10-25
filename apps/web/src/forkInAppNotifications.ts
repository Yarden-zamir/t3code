import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { getClientSettings } from "./hooks/useSettings";
import { threadNotificationTag } from "./threadNotifications";
import { toastManager } from "./components/ui/toast";
import {
  type InAppNotificationKind,
  inAppNotificationTimeout,
} from "./forkInAppNotifications.logic";

const openToasts = new Map<string, Set<string>>();

/**
 * Fork: adds an in-app thread notification with the in-app notification settings, or shows
 * nothing when they turn this kind off. The toast is kept by thread for `closeThreadToasts`.
 */
export function addThreadToast(
  thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  kind: InAppNotificationKind,
  options: Parameters<typeof toastManager.add>[0],
): string | null {
  const timeout = inAppNotificationTimeout(kind, getClientSettings());
  if (timeout === null) return null;
  const key = threadNotificationTag(thread.environmentId, thread.threadId);
  const ids = openToasts.get(key) ?? new Set<string>();
  const toastId = toastManager.add({
    ...options,
    timeout,
    onRemove: () => {
      ids.delete(toastId);
      if (ids.size === 0 && openToasts.get(key) === ids) openToasts.delete(key);
    },
  });
  ids.add(toastId);
  openToasts.set(key, ids);
  return toastId;
}

/** Fork: with `inAppNotificationClosesOnOpen` on, closes the in-app notifications of a thread. */
export function closeThreadToasts(environmentId: EnvironmentId, threadId: ThreadId): void {
  if (!getClientSettings().inAppNotificationClosesOnOpen) return;
  const ids = openToasts.get(threadNotificationTag(environmentId, threadId));
  for (const toastId of ids ?? []) toastManager.close(toastId);
}
