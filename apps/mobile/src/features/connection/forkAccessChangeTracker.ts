/**
 * Fork: `accessChangeNotices` on mobile, with the rules of `@t3tools/client-runtime/fork/accessChange`.
 * One tracker for the app session, so a remount does not count as the first value. This module
 * imports no connection runtime and no dialog, because the app token repair, which the runtime
 * starts, uses it. `ForkAccessChangeNotices` sets the function that presents a notice.
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

let present: ((notice: AccessChangeNotice) => void) | null = null;

export function setAccessChangeNoticePresenter(next: (notice: AccessChangeNotice) => void) {
  present = next;
}

/**
 * The Android dialog shows one request at a time, so the notices of one update show as one popup.
 * Known limit: a later popup replaces an open one, also an unrelated dialog, as
 * `PermissionUpdateNotice` does. Revisit if the dialog host gets a queue.
 */
export function showAccessChangeNotices(notices: ReadonlyArray<AccessChangeNotice>) {
  const [first] = notices;
  if (first === undefined) return;
  present?.(
    notices.length === 1
      ? first
      : {
          title: "Access changed",
          description: notices
            .map((notice) => `${notice.title}. ${notice.description}`)
            .join("\n\n"),
        },
  );
}

/** MM-914: the app turned off a machine whose arrow is `none`. */
export function noticeAccessEnded(environmentId: EnvironmentId) {
  const environment = accessChangeEnvironments.get(environmentId);
  const notice = accessChangeTracker.observeEnded(environmentId, environment?.label ?? "a machine");
  if (notice !== null && environment?.enabled === true) showAccessChangeNotices([notice]);
}
