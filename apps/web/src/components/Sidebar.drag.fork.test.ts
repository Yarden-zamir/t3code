import { describe, expect, it } from "vite-plus/test";
import type { SortingStrategy } from "@dnd-kit/sortable";
import { createSidebarSortingStrategy } from "./Sidebar.drag";
import {
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "./Sidebar.logic";

const thread = (key: string, section: SidebarSection): SidebarListItem => ({
  kind: "thread",
  key,
  section,
});
const marker = (marker: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker });
const pinnedHeader = marker("pinned-header");
const divider = marker("pinned-divider");
const settledHeader = marker("settled-header");

function layout(
  items: readonly SidebarListItem[],
  active: string,
  over: string,
  scale = 1,
  cardHeight = 82,
) {
  let top = 100;
  const rects = items.map((item) => {
    const height =
      item.kind === "thread"
        ? (item.section === "pinned" || item.section === "active" ? cardHeight : 36) * scale
        : item.marker === "pinned-header" || item.marker === "pinned-divider"
          ? 0
          : (item.marker.endsWith("placeholder") ? 0 : 32) * scale;
    const rect = { top, height, bottom: top + height, left: 0, right: 260, width: 260 };
    top += height + 1;
    return rect;
  });
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === active);
  return {
    activeIndex,
    overIndex: items.findIndex((item) => sidebarListItemId(item) === over),
    activeNodeRect: rects[activeIndex]!,
    rects,
    index: 0,
  } satisfies Parameters<SortingStrategy>[0];
}

function preview(
  input: Parameters<typeof createSidebarSortingStrategy>[0],
  active: string,
  over: string,
  scale = 1,
) {
  const strategy = createSidebarSortingStrategy(input);
  const args = layout(input.items, active, over, scale);
  return new Map(
    input.items.map((item, index) => [sidebarListItemId(item), strategy({ ...args, index })]),
  );
}

describe("sidebar drag projection", () => {
  it("keeps folded shelves still when a row goes into the collapsed Settled shelf", () => {
    // A long list: no free space above the shelves to absorb the row that leaves.
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      thread("a3", "active"),
      marker("working-header"),
      marker("snoozed-header"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const input = { items, settledOrder: [], settledExpanded: false, snoozedThreadCount: 2 };
    const overActive = preview(input, "a2", "a1");
    const overSettled = preview(input, "a2", sidebarMarkerId("settled-placeholder"));
    // No hidden row: the rows below the source close the gap.
    expect(overSettled.get("a3")?.y).toBe(-83);
    for (const shelf of ["working-header", "snoozed-header", "settled-header"] as const) {
      // A shelf that moved up here would shorten the list, clamp its scroll position and flip
      // the target under the pointer.
      expect(overSettled.get(sidebarMarkerId(shelf))).toEqual(
        overActive.get(sidebarMarkerId(shelf)),
      );
    }
  });

  it("keeps the shelves still when the only Active row leaves for the collapsed Settled shelf", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const input = { items, settledOrder: [], settledExpanded: false };
    expect(
      preview(input, "a", sidebarMarkerId("settled-placeholder")).get(
        sidebarMarkerId("settled-header"),
      ),
    ).toEqual(preview(input, "a", "a").get(sidebarMarkerId("settled-header")));
  });
});
