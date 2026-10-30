import { describe, expect, it } from "vite-plus/test";

import { forkHistoryVisit, recordForkHistoryNavigation } from "./forkMessageHistory";
import { readTimelinePosition, rememberTimelinePosition } from "./timelineScrollAnchoring";

const at = (rowId: string) => ({ rowId, offsetWithinRow: 0, scrollOffset: 0, atEnd: false });

// Positions are kept per thread key, so every test uses fresh thread keys.
function threads() {
  const suffix = Math.random().toString(36).slice(2);
  return { a: `env:a-${suffix}`, b: `env:b-${suffix}`, key: (name: string) => `${name}-${suffix}` };
}

describe("fork message history", () => {
  it("returns to where the user was when Back leaves a jump in the same thread", () => {
    const { a, key } = threads();
    rememberTimelinePosition(a, at("reading"), false);
    recordForkHistoryNavigation(
      { entryKey: key("start"), threadKey: a },
      { entryKey: key("jump"), threadKey: a },
    );
    const jump = forkHistoryVisit(key("jump"));
    expect(jump.revisit).toBe(false);
    // A reload of the same entry does not restart the jump.
    recordForkHistoryNavigation(
      { entryKey: key("jump"), threadKey: a },
      { entryKey: key("jump"), threadKey: a },
    );
    expect(forkHistoryVisit(key("jump"))).toBe(jump);

    rememberTimelinePosition(a, at("linked"), false);
    recordForkHistoryNavigation(
      { entryKey: key("jump"), threadKey: a },
      { entryKey: key("start"), threadKey: a },
    );
    expect(forkHistoryVisit(key("start")).position?.rowId).toBe("reading");

    // Forward comes back to the jump entry where the user left it, as a new visit.
    rememberTimelinePosition(a, at("reading"), false);
    recordForkHistoryNavigation(
      { entryKey: key("start"), threadKey: a },
      { entryKey: key("jump"), threadKey: a },
    );
    const again = forkHistoryVisit(key("jump"));
    expect(again.position?.rowId).toBe("linked");
    expect(again.id).not.toBe(jump.id);
  });

  it("gives a revisited thread its entry position through the thread restore", () => {
    const { a, b, key } = threads();
    rememberTimelinePosition(a, at("reading"), false);
    recordForkHistoryNavigation(
      { entryKey: key("start"), threadKey: a },
      { entryKey: key("other"), threadKey: b },
    );
    rememberTimelinePosition(a, at("later"), false);
    recordForkHistoryNavigation(
      { entryKey: key("other"), threadKey: b },
      { entryKey: key("start"), threadKey: a },
    );
    const visit = forkHistoryVisit(key("start"));
    expect(visit.revisit).toBe(true);
    expect(visit.position).toBeUndefined();
    expect(readTimelinePosition(a)?.rowId).toBe("reading");
  });

  it("treats an entry that nothing recorded as a first visit", () => {
    expect(forkHistoryVisit("never-recorded")).toMatchObject({ id: 0, revisit: false });
  });
});
