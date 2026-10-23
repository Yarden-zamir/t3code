/**
 * Fork: `accessChangeNotices` on mobile, with the rules of `@t3tools/client-runtime/fork/accessChange`.
 * One tracker for the app session, so a remount does not count as the first value. This module
 * imports no connection runtime and no dialog, because the app token repair, which the runtime
 * starts, uses it. `ForkAccessChangeNotices` sets the function that shows a notice.
 */
import {
  type AccessChangeNotice,
  createAccessChangeTracker,
} from "@t3tools/client-runtime/fork/accessChange";
import type { EnvironmentId } from "@t3tools/contracts";

export const accessChangeTracker = createAccessChangeTracker();

/** The label and `accessChangeNotices` of each environment, as its watcher last saw them. */
export const accessChangeEnvironments = new Map<
  EnvironmentId,
  { readonly label: string; readonly enabled: boolean }
>();

let showNotice: ((notice: AccessChangeNotice) => void) | null = null;

export function setAccessChangeNoticeHandler(handler: (notice: AccessChangeNotice) => void) {
  showNotice = handler;
}

/** MM-914: the app turned off a machine whose arrow is `none`. */
export function noticeAccessEnded(environmentId: EnvironmentId) {
  const environment = accessChangeEnvironments.get(environmentId);
  const notice = accessChangeTracker.observeEnded(environmentId, environment?.label ?? "a machine");
  if (notice !== null && environment?.enabled !== false) showNotice?.(notice);
}
