import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { __setClientSettingsForTests } from "../hooks/useSettings";
import { startNewThreadFromContext, type ForkThreadActionContext } from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const PROJECT_REF = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);

function setup(currentProjectTerminalOpensThread: boolean) {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, currentProjectTerminalOpensThread });
  return {
    activeDraftThread: null,
    activeThread: { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
    defaultProjectRef: null,
    handleNewThread: vi.fn<ForkThreadActionContext["handleNewThread"]>(async () => {}),
    handleNewTerminalThread: vi.fn<ForkThreadActionContext["handleNewTerminalThread"]>(
      async () => {},
    ),
  };
}

describe("startNewThreadFromContext", () => {
  it("starts a terminal draft in the context project for the terminal kind", async () => {
    const context = setup(false);

    const didStart = await startNewThreadFromContext(context, "terminal");

    expect(didStart).toBe(true);
    expect(context.handleNewTerminalThread).toHaveBeenCalledWith(PROJECT_REF, {
      opensAsThread: false,
    });
    expect(context.handleNewThread).not.toHaveBeenCalled();
  });

  it("opens the terminal thread at once when currentProjectTerminalOpensThread is on", async () => {
    const context = setup(true);

    await startNewThreadFromContext(context, "terminal");

    expect(context.handleNewTerminalThread).toHaveBeenCalledWith(PROJECT_REF, {
      opensAsThread: true,
    });
  });
});
