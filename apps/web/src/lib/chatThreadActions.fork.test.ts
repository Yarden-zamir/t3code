import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { startNewThreadFromContext, type ChatThreadActionContext } from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");

describe("startNewThreadFromContext", () => {
  it("starts a terminal thread in the context project for the terminal kind", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
    const handleNewTerminalThread = vi.fn<ChatThreadActionContext["handleNewTerminalThread"]>(
      async () => {},
    );

    const didStart = await startNewThreadFromContext(
      {
        activeDraftThread: null,
        activeThread: { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
        defaultProjectRef: null,
        handleNewThread,
        handleNewTerminalThread,
      },
      "terminal",
    );

    expect(didStart).toBe(true);
    expect(handleNewTerminalThread).toHaveBeenCalledWith(
      scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
    );
    expect(handleNewThread).not.toHaveBeenCalled();
  });
});
