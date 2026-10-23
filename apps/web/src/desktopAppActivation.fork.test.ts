import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleDesktopAppActivationRequest,
  type DesktopAppActivationDependencies,
} from "./desktopAppActivation";

const environmentId = EnvironmentId.make("primary");
const existingProjectId = ProjectId.make("project-existing");
const threadId = ThreadId.make("thread-1");
const request = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
} as const;

function dependencies(): DesktopAppActivationDependencies {
  return {
    getTarget: () => ({ environmentId, platform: "linux" }),
    findProject: () => ({
      id: existingProjectId,
      environmentId,
      workspaceRoot: request.workspaceRoot,
    }),
    createProject: vi.fn(async () => ProjectId.make("project-created")),
    waitForProject: vi.fn(async () => undefined),
    openThread: vi.fn(async () => ({ threadId })),
  };
}

describe("desktop app activation", () => {
  it("opens the thread in the requested checkout", async () => {
    const deps = dependencies();
    const checkout = { worktreePath: "/workspace/feature", branch: "feat/feature" };

    await handleDesktopAppActivationRequest({ ...request, checkout }, deps);

    expect(deps.openThread).toHaveBeenCalledWith(
      { environmentId, projectId: existingProjectId },
      checkout,
    );
  });
});
