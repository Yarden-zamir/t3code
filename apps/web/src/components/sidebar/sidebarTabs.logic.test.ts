import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type SidebarTab,
  type SidebarTabs,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  buildSidebarTabProjectFacts,
  compileSidebarTabs,
  DEFAULT_SIDEBAR_TAB_ID,
  fitSidebarTabItems,
  moveSidebarThreads,
  pruneSidebarTabAssignments,
  resolveSidebarThreadTabId,
  sidebarTabShowsThread,
  sidebarTabThreadKey,
  toggleSidebarTabRuleValue,
} from "./sidebarTabs.logic";

const mac = EnvironmentId.make("environment-mac");
const vps = EnvironmentId.make("environment-vps");

// The same repository is a different project on each machine.
const projects = buildSidebarTabProjectFacts([
  {
    environmentId: mac,
    id: "project-mac",
    repositoryIdentity: {
      canonicalKey: "github.com/yarden-zamir/t3code",
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "https://x" },
    },
  },
  {
    environmentId: vps,
    id: "project-vps",
    repositoryIdentity: {
      canonicalKey: "github.com/yarden-zamir/t3code",
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: "https://x" },
    },
  },
]);

const thread = (environmentId: EnvironmentId, title: string, projectId = "project-mac") =>
  makeThreadFixture({
    environmentId,
    id: ThreadId.make(title),
    projectId: ProjectId.make(projectId),
    title,
  });

const conductor = thread(mac, "Conductor");
const other = thread(mac, "Fix overlay");
const monitors: SidebarTab = {
  id: "monitors",
  name: "Monitors",
  rules: [{ field: "title", operator: "is", values: ["conductor"] }],
};
const all: SidebarTab = {
  id: "all",
  name: "All",
  rules: [{ field: "tab", operator: "is_not", values: [] }],
};
const settings = (
  tabs: SidebarTab[],
  assignments: SidebarTabs["assignments"] = {},
): SidebarTabs => ({ tabs, assignments, defaultTab: {} });
const tabOf = (subject: typeof conductor, value: SidebarTabs) =>
  resolveSidebarThreadTabId(subject, compileSidebarTabs(value), projects);

describe("sidebar tab resolution", () => {
  it("prefers a drag assignment, then the first matching tab, then the default tab", () => {
    const value = settings([monitors], { [sidebarTabThreadKey(other)]: "monitors" });
    expect(tabOf(other, value)).toBe("monitors");
    expect(tabOf(conductor, settings([monitors]))).toBe("monitors");
    expect(tabOf(other, settings([monitors]))).toBe(DEFAULT_SIDEBAR_TAB_ID);
  });

  it("matches a repository rule on every machine, not by project id", () => {
    const repo: SidebarTab = {
      id: "repo",
      name: "t3code",
      rules: [{ field: "project", operator: "is", values: ["github.com/yarden-zamir/t3code"] }],
    };
    expect(tabOf(thread(vps, "On the VPS", "project-vps"), settings([repo]))).toBe("repo");
  });

  it("skips a rule from a newer version instead of letting it claim every thread", () => {
    const future: SidebarTab = {
      id: "future",
      name: "Future",
      rules: [{ field: "label", operator: "has", values: ["x"] }],
    };
    expect(tabOf(other, settings([future]))).toBe(DEFAULT_SIDEBAR_TAB_ID);
  });

  it("shows every thread in an any-tab view, which holds none itself", () => {
    const value = settings([monitors, all]);
    const shows = (subject: typeof conductor) =>
      sidebarTabShowsThread({
        tabId: "all",
        thread: subject,
        threadTabId: tabOf(subject, value),
        compiled: compileSidebarTabs(value),
        projects,
      });
    expect([shows(conductor), shows(other)]).toEqual([true, true]);
    expect(tabOf(other, value)).toBe(DEFAULT_SIDEBAR_TAB_ID);
  });
});

describe("sidebar tab assignments", () => {
  it("writes an entry only where the rules give another tab", () => {
    const value = settings([monitors]);
    // Already in its tab: no change.
    expect(moveSidebarThreads(value, [conductor], "monitors", projects)).toEqual(value);
    // No rule claims it: a drop on the default tab writes nothing.
    expect(moveSidebarThreads(value, [other], DEFAULT_SIDEBAR_TAB_ID, projects)).toEqual(value);
    // A rule claims it: the default entry keeps it out.
    expect(
      moveSidebarThreads(value, [conductor], DEFAULT_SIDEBAR_TAB_ID, projects).assignments,
    ).toEqual({ [sidebarTabThreadKey(conductor)]: DEFAULT_SIDEBAR_TAB_ID });
  });

  it("prunes entries of gone threads only, also when the rules agree with an entry", () => {
    const value = settings([monitors], {
      [sidebarTabThreadKey(other)]: "monitors",
      "environment-mac:deleted-thread": "monitors",
      "environment-offline:thread": "monitors",
      [sidebarTabThreadKey(conductor)]: "monitors",
    });
    // The rules put Conductor in Monitors now, but a title or status can change: the drag holds.
    expect(pruneSidebarTabAssignments(value, [conductor, other]).assignments).toEqual({
      [sidebarTabThreadKey(other)]: "monitors",
      "environment-offline:thread": "monitors",
      [sidebarTabThreadKey(conductor)]: "monitors",
    });
  });
});

describe("fitSidebarTabItems", () => {
  it("shows whole tabs only, keeps the selected tab, and leaves room for the more menu", () => {
    const widths = [70, 60, 80, 90];
    expect(
      fitSidebarTabItems({ widths, available: 400, gap: 4, moreWidth: 40, selectedIndex: 0 }),
    ).toEqual([0, 1, 2, 3]);
    // 200 px: the menu takes 44 px, so tabs 0 and 1 fit in 156 px.
    expect(
      fitSidebarTabItems({ widths, available: 200, gap: 4, moreWidth: 40, selectedIndex: 1 }),
    ).toEqual([0, 1]);
    // The selected last tab replaces the tabs that would push it out.
    expect(
      fitSidebarTabItems({ widths, available: 200, gap: 4, moreWidth: 40, selectedIndex: 3 }),
    ).toEqual([3]);
  });
});

describe("toggleSidebarTabRuleValue", () => {
  it("keeps a view a view when its last tab is unchecked, and drops other empty rules", () => {
    const view: SidebarTab["rules"] = [{ field: "tab", operator: "is", values: ["monitors"] }];
    expect(toggleSidebarTabRuleValue(view, "tab", "monitors", false)).toEqual([
      { field: "tab", operator: "is_not", values: [] },
    ]);
    const status: SidebarTab["rules"] = [{ field: "status", operator: "is", values: ["input"] }];
    expect(toggleSidebarTabRuleValue(status, "status", "input", false)).toEqual([]);
  });
});
