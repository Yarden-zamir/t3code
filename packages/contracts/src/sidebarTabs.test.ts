import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  moveLegacySidebarTabKeys,
  renameLegacySidebarTabCommands,
  SidebarTabs,
} from "./sidebarTabs.ts";

const isSidebarTabs = Schema.is(SidebarTabs);

const legacyGroups = {
  groups: [
    {
      id: "monitors",
      name: "Monitors",
      rules: [{ field: "group", operator: "is", values: ["x"] }],
    },
  ],
  assignments: { "environment:thread-1": "monitors" },
  defaultTab: { name: "Inbox", show: "ungrouped" },
};

describe("moveLegacySidebarTabKeys", () => {
  it("moves the server keys and gives the value the tab shape", () => {
    const moved = moveLegacySidebarTabKeys("server", {
      sidebarGroups: legacyGroups,
      mobileSidebarGroups: true,
      other: 1,
    });
    expect(moved).toEqual({
      other: 1,
      mobileSidebarTabs: true,
      sidebarTabs: {
        tabs: [
          {
            id: "monitors",
            name: "Monitors",
            rules: [{ field: "tab", operator: "is", values: ["x"] }],
          },
        ],
        assignments: { "environment:thread-1": "monitors" },
        defaultTab: { name: "Inbox", show: "untabbed" },
      },
    });
    expect(isSidebarTabs(moved?.sidebarTabs)).toBe(true);
  });

  it("moves once: the moved values hold no old key, and a new key wins over an old one", () => {
    const moved = moveLegacySidebarTabKeys("client", {
      sidebarGroupsEnabled: true,
      sidebarGroupSingleThreadOpens: true,
      sidebarTabSingleThreadOpens: false,
    });
    expect(moved).toEqual({ sidebarTabsEnabled: true, sidebarTabSingleThreadOpens: false });
    expect(moveLegacySidebarTabKeys("client", moved!)).toBeNull();
    expect(moveLegacySidebarTabKeys("server", { sidebarTabs: {} })).toBeNull();
  });
});

describe("renameLegacySidebarTabCommands", () => {
  it("renames the old sidebar group commands and keeps every other entry", () => {
    const custom = { key: "mod+k", command: "commandPalette.toggle" };
    expect(
      renameLegacySidebarTabCommands([
        { key: "1", command: "sidebar.group.1", when: "sidebarFocus" },
        { key: "arrowleft", command: "sidebar.previousGroup" },
        { key: "arrowright", command: "sidebar.nextGroup" },
        custom,
        "not a rule",
      ]),
    ).toEqual([
      { key: "1", command: "sidebar.tab.1", when: "sidebarFocus" },
      { key: "arrowleft", command: "sidebar.previousTab" },
      { key: "arrowright", command: "sidebar.nextTab" },
      custom,
      "not a rule",
    ]);
    expect(renameLegacySidebarTabCommands([custom])).toBeNull();
  });
});
