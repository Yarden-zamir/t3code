import {
  readTimelinePosition,
  rememberTimelinePosition,
  type RememberedTimelinePosition,
} from "./timelineScrollAnchoring";

/*
 * Fork: Back and Forward return to where the user was in each history entry. A message jump
 * pushes an entry, and leaving an entry keeps its timeline position by the entry key.
 * Known limit: the positions live in memory, so after a reload an entry opens at its message
 * again. Revisit if Back after a reload must land on the exact old position.
 */

export interface ForkHistoryLocation {
  /** `__TSR_key` of the entry. */
  readonly entryKey: string | undefined;
  /** `scopedThreadKey` of the thread route, or null for another route. */
  readonly threadKey: string | null;
}

/** One visit of a history entry. */
export interface ForkHistoryVisit {
  readonly entryKey: string;
  /** New on each visit, so a revisit of an entry positions the timeline again. */
  readonly id: number;
  /** The user left this entry before, so it returns to where they were. */
  readonly revisit: boolean;
  /** The position to restore in the timeline that already shows the thread. */
  readonly position: RememberedTimelinePosition | undefined;
}

const MAX_ENTRIES = 100;
const entryPositions = new Map<
  string,
  { readonly threadKey: string; readonly position: RememberedTimelinePosition }
>();
let lastVisit: ForkHistoryVisit | null = null;

/**
 * Fork: records a history navigation before the new location renders. It keeps the position of
 * the entry that the user leaves. For a revisit of another thread, it gives that thread's
 * remembered position to the timeline's own thread restore.
 */
export function recordForkHistoryNavigation(
  from: ForkHistoryLocation | undefined,
  to: ForkHistoryLocation,
) {
  // A reload of the same entry, such as `router.invalidate`, is no visit.
  if (from?.entryKey === to.entryKey) return;
  if (from?.entryKey !== undefined && from.threadKey !== null) {
    const position = readTimelinePosition(from.threadKey);
    if (position) {
      entryPositions.delete(from.entryKey);
      entryPositions.set(from.entryKey, { threadKey: from.threadKey, position });
      if (entryPositions.size > MAX_ENTRIES) {
        const oldest = entryPositions.keys().next().value;
        if (oldest !== undefined) entryPositions.delete(oldest);
      }
    }
  }
  if (to.entryKey === undefined) return;
  const saved = entryPositions.get(to.entryKey);
  const revisit = saved !== undefined && saved.threadKey === to.threadKey;
  const sameThread = to.threadKey === from?.threadKey;
  if (revisit && !sameThread) rememberTimelinePosition(saved.threadKey, saved.position, false);
  lastVisit = {
    entryKey: to.entryKey,
    id: (lastVisit?.id ?? 0) + 1,
    revisit,
    position: revisit && sameThread ? saved.position : undefined,
  };
}

/** Fork: the visit of the entry `entryKey`, or a first visit when no navigation recorded it. */
export function forkHistoryVisit(entryKey: string): ForkHistoryVisit {
  return lastVisit?.entryKey === entryKey
    ? lastVisit
    : { entryKey, id: 0, revisit: false, position: undefined };
}
