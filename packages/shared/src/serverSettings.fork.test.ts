import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveProjectScripts } from "./projectScripts.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const FOLDED_SERVER_SETTINGS = { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true };

describe("serverSettings helpers", () => {
  it("replaces the sidebar groups whole, so deleted groups and assignments stay deleted", () => {
    const saved = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sidebarGroups: {
        groups: [{ id: "monitors", name: "Monitors", rules: [] }],
        assignments: { "environment:thread-1": "monitors", "environment:thread-2": "default" },
        defaultTab: {},
      },
    });
    const next = applyServerSettingsPatch(saved, {
      sidebarGroups: {
        groups: [],
        assignments: { "environment:thread-2": "default" },
        defaultTab: {},
      },
    });
    expect(next.sidebarGroups).toEqual({
      groups: [],
      assignments: { "environment:thread-2": "default" },
      defaultTab: {},
    });
  });

  it("keeps runInBackground through global and project script saves", () => {
    const projectId = ProjectId.make("project-background");
    const script = {
      id: "nav",
      name: "Navgator",
      command: "bash nav.sh",
      icon: "play" as const,
      runOnWorktreeCreate: false,
      runInBackground: true,
    };
    const saved = applyServerSettingsPatch(FOLDED_SERVER_SETTINGS, {
      globalScripts: [script],
      projectScriptOverrides: { [projectId]: [script] },
    });
    expect(saved.globalScripts).toEqual([script]);
    expect(resolveProjectScripts(saved, { id: projectId, scripts: [] })).toEqual([script]);
  });
});
