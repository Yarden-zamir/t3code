import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_TERMINAL_ID,
  type EnvironmentId,
  type ScopedProjectRef,
  TERMINAL_THREAD_MODEL_SELECTION,
} from "@t3tools/contracts";
import { terminalThreadLaunch } from "@t3tools/shared/terminalThreadLaunch";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";

import { toastManager } from "../components/ui/toast";
import { newThreadId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { terminalEnvironment } from "../state/terminal";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { waitForAtomValue } from "../state/waitForAtomValue";

// The thread shell normally arrives in well under a second. Limit: when it arrives later, the
// thread route finds no thread and goes home. Revisit if slow connections show that.
const THREAD_SHELL_WAIT_MS = 5_000;

/** Fork: the `terminalThreads` server setting of an environment. */
const terminalThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(serverEnvironment.settingsValueAtom(environmentId))?.terminalThreads === true,
  ),
);

const OFF_ATOM = Atom.make(false);

export function useTerminalThreadsEnabled(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(environmentId ? terminalThreadsAtom(environmentId) : OFF_ATOM);
}

/** Fork: the connected environments whose server has `terminalThreads` on. */
export function useTerminalThreadEnvironmentIds(): ReadonlySet<EnvironmentId> {
  const { environments } = useEnvironments();
  return new Set(
    environments
      .filter((environment) => environment.serverConfig?.settings.terminalThreads === true)
      .map((environment) => environment.environmentId),
  );
}

/**
 * Fork: creates a terminal thread (`forkTerminalThreads.ts`) in a project and opens it. Every way
 * to create a terminal thread ends here, through `startNewThreadFromContext` with kind "terminal".
 */
export function useCreateTerminalThread() {
  const createThread = useOrchestrationCommand(threadEnvironment.create);
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const navigate = useNavigate();
  return async (projectRef: ScopedProjectRef) => {
    const project = readProject(projectRef);
    if (project === null) throw new Error(`Project ${projectRef.projectId} is not loaded.`);
    if (!appAtomRegistry.get(terminalThreadsAtom(projectRef.environmentId))) {
      toastManager.add({
        type: "error",
        title: "Terminal threads are off",
        description: `Turn on terminal threads in the settings of the server of ${project.title}.`,
      });
      return;
    }
    const threadId = newThreadId();
    const created = createThread({
      environmentId: projectRef.environmentId,
      input: {
        threadId,
        projectId: projectRef.projectId,
        title: "Terminal",
        modelSelection: TERMINAL_THREAD_MODEL_SELECTION,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      },
    });
    // The shell starts while the server creates the thread. The screen opens it again with the
    // same cwd and environment, which the server treats as the same session.
    const launch = terminalThreadLaunch({
      workspaceRoot: project.workspaceRoot,
      worktreePath: null,
    });
    void openTerminal({
      environmentId: projectRef.environmentId,
      input: { threadId, terminalId: DEFAULT_TERMINAL_ID, cwd: launch.cwd, env: { ...launch.env } },
    });
    if ((await created)._tag === "Failure") return;
    await waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentThreadShells.threadShellAtom(
        scopeThreadRef(projectRef.environmentId, threadId),
      ),
      predicate: (thread) => thread !== null,
      timeoutMs: THREAD_SHELL_WAIT_MS,
    });
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: projectRef.environmentId, threadId },
    });
  };
}
