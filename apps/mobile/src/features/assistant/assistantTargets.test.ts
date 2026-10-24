import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { lastOpenedThread, projectsForPicker, recentThreadsForPicker } from "./assistantTargets";

const environmentId = EnvironmentId.make("env");

function thread(title: string, projectId: string, seen: string, archived = false) {
  return {
    title,
    projectId: ProjectId.make(projectId),
    environmentId,
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastVisitedAt: seen,
    archivedAt: archived ? "2026-01-02T00:00:00.000Z" : null,
  };
}

const threads = [
  thread("Fix login", "app", "2026-03-01T00:00:00.000Z"),
  thread("Write docs", "docs", "2026-03-03T00:00:00.000Z"),
  thread("Old archived", "app", "2026-03-09T00:00:00.000Z", true),
];

describe("assistant targets", () => {
  it("finds the last opened thread and skips archived threads", () => {
    expect(lastOpenedThread(threads)?.title).toBe("Write docs");
    expect(lastOpenedThread([])).toBeNull();
  });

  it("lists recent threads last opened first and filters by title", () => {
    expect(recentThreadsForPicker(threads, "").map((entry) => entry.title)).toEqual([
      "Write docs",
      "Fix login",
    ]);
    expect(recentThreadsForPicker(threads, "LOGIN").map((entry) => entry.title)).toEqual([
      "Fix login",
    ]);
  });

  it("orders projects by their latest thread, then by title", () => {
    const projects = [
      { id: ProjectId.make("app"), environmentId, title: "App" },
      { id: ProjectId.make("docs"), environmentId, title: "Docs" },
      { id: ProjectId.make("idle"), environmentId, title: "Idle" },
    ];
    expect(projectsForPicker(projects, threads, "").map((project) => project.title)).toEqual([
      "Docs",
      "App",
      "Idle",
    ]);
    expect(projectsForPicker(projects, threads, "id").map((project) => project.title)).toEqual([
      "Idle",
    ]);
  });
});
