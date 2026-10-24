import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { resolveAssistantProject } from "./assistantProject";

const environmentId = EnvironmentId.make("environment");

function makeProject(id: string, workspaceRoot = `/work/${id}`): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

const app = makeProject("app");
const scratch = makeProject("scratch", "/scratch");
const docs = makeProject("docs");
const noScratchRoot = () => undefined;

describe("resolveAssistantProject", () => {
  it("uses the project chosen in settings while it exists", () => {
    const preferences = {
      lastNewThreadProject: { environmentId, projectId: "docs", scratch: false },
    };
    expect(
      resolveAssistantProject({
        chosen: { environmentId, projectId: "app" },
        projects: [app, docs],
        preferences,
        scratchWorkspaceRoot: noScratchRoot,
      }),
    ).toBe(app);
    expect(
      resolveAssistantProject({
        chosen: { environmentId, projectId: "deleted" },
        projects: [app, docs],
        preferences,
        scratchWorkspaceRoot: noScratchRoot,
      }),
    ).toBe(docs);
  });

  it("uses the project of the last new thread", () => {
    expect(
      resolveAssistantProject({
        chosen: null,
        projects: [app, scratch, docs],
        preferences: {
          lastNewThreadProject: { environmentId, projectId: "docs", scratch: false },
          scratchProject: { environmentId, projectId: "scratch" },
        },
        scratchWorkspaceRoot: noScratchRoot,
      }),
    ).toBe(docs);
  });

  it("falls back to the remembered scratch project when the last project is gone", () => {
    expect(
      resolveAssistantProject({
        chosen: null,
        projects: [app, scratch],
        preferences: {
          lastNewThreadProject: { environmentId, projectId: "deleted", scratch: false },
          scratchProject: { environmentId, projectId: "scratch" },
        },
        scratchWorkspaceRoot: noScratchRoot,
      }),
    ).toBe(scratch);
  });

  it("finds the scratch project by the server scratch root without preferences", () => {
    expect(
      resolveAssistantProject({
        chosen: null,
        projects: [app, scratch],
        preferences: {},
        scratchWorkspaceRoot: () => "/scratch",
      }),
    ).toBe(scratch);
  });

  it("uses the first project, and null without projects", () => {
    expect(
      resolveAssistantProject({
        chosen: null,
        projects: [app, docs],
        preferences: {},
        scratchWorkspaceRoot: noScratchRoot,
      }),
    ).toBe(app);
    expect(
      resolveAssistantProject({
        chosen: null,
        projects: [],
        preferences: {},
        scratchWorkspaceRoot: noScratchRoot,
      }),
    ).toBeNull();
  });
});
