import {
  isTerminalThread,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** A warm-up loads every unread or waiting thread, then the newest threads by activity. */
export const CACHE_WARMUP_NEWEST_THREADS = 10;
/**
 * Hard cap on the threads of one warm-up of one environment. Each thread loads the bounded
 * window that an opened thread loads (the server's THREAD_HISTORY_PAGE_POLICY: 10 user turns,
 * 75 items, at most 1 MiB), so one warm-up loads at most 15 MiB. Revisit when the sync timings
 * show a warm-up that delays the open thread, or when that window grows.
 */
export const CACHE_WARMUP_MAX_THREADS = 15;

// The thread cache does not save a thread with an active run (`shouldPersistThread`).
const UNSAVED_RUN_STATUSES: ReadonlySet<string> = new Set(["preparing", "starting", "running"]);

/** Unread, or waiting for an answer of the user. The user opens these threads next. */
function needsAttention(thread: OrchestrationV2ThreadShell): boolean {
  if (thread.activityRunStatus === "waiting" || thread.pendingRuntimeRequest !== null) return true;
  // The thread list marks a thread unread with the same rule.
  const completedAt = thread.latestRunCompletedAt ?? null;
  const visitedAt = thread.lastVisitedAt ?? null;
  return (
    completedAt !== null &&
    visitedAt !== null &&
    DateTime.toEpochMillis(completedAt) > DateTime.toEpochMillis(visitedAt)
  );
}

/**
 * The threads to load into the message cache, unread and waiting threads first. A thread whose cache was
 * saved after its last server change is current and is skipped. The save time is the
 * device clock and the change time is the server clock, so a clock that runs ahead skips a
 * thread that changed in that gap; the thread then loads when it opens, as before.
 */
export function selectCacheWarmupThreads(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  cacheSavedAtMs: ReadonlyMap<string, number>,
): ReadonlyArray<ThreadId> {
  const byActivity = threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        !isTerminalThread(thread) &&
        !UNSAVED_RUN_STATUSES.has(thread.activityRunStatus ?? ""),
    )
    .map((thread) => ({ thread, changedAtMs: DateTime.toEpochMillis(thread.updatedAt) }))
    .sort((left, right) => right.changedAtMs - left.changedAtMs);
  const urgent = byActivity.filter(({ thread }) => needsAttention(thread));
  const selected = new Set<ThreadId>();
  for (const { thread, changedAtMs } of [
    ...urgent,
    ...byActivity.slice(0, CACHE_WARMUP_NEWEST_THREADS),
  ]) {
    if (selected.size >= CACHE_WARMUP_MAX_THREADS) break;
    if ((cacheSavedAtMs.get(thread.id) ?? -Infinity) >= changedAtMs) continue;
    selected.add(thread.id);
  }
  return [...selected];
}
