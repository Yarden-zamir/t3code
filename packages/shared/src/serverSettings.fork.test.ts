import { DEFAULT_SERVER_SETTINGS, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveProjectScripts } from "./projectScripts.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const FOLDED_SERVER_SETTINGS = { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true };

describe("serverSettings helpers", () => {
  it("adds and removes pinned messages per entry, so two clients keep each other's pins", () => {
    const pin = (messageId: string) => ({
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make(messageId),
      pinnedAt: "2026-10-25T00:00:00.000Z",
      excerpt: messageId,
      threadTitle: "Pins",
    });
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      pinnedMessages: { "thread-1#m1": pin("m1") },
    });
    const both = applyServerSettingsPatch(first, { pinnedMessages: { "thread-1#m2": pin("m2") } });
    expect(Object.keys(both.pinnedMessages)).toEqual(["thread-1#m1", "thread-1#m2"]);
    const next = applyServerSettingsPatch(both, { pinnedMessages: { "thread-1#m1": null } });
    expect(next.pinnedMessages).toEqual({ "thread-1#m2": pin("m2") });
  });

  it("replaces the sidebar tabs whole, so deleted tabs and assignments stay deleted", () => {
    const saved = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sidebarTabs: {
        tabs: [{ id: "monitors", name: "Monitors", rules: [] }],
        assignments: { "environment:thread-1": "monitors", "environment:thread-2": "default" },
        defaultTab: {},
      },
    });
    const next = applyServerSettingsPatch(saved, {
      sidebarTabs: {
        tabs: [],
        assignments: { "environment:thread-2": "default" },
        defaultTab: {},
      },
    });
    expect(next.sidebarTabs).toEqual({
      tabs: [],
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
