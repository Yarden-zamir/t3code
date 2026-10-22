import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ScopedProjectRef,
  TERMINAL_THREAD_MODEL_SELECTION,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";

import { waitForStartedServerThread } from "../components/ChatView.logic";
import { newThreadId } from "../lib/utils";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

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

/** Fork: creates a terminal thread (`forkTerminalThreads.ts`) in a project and opens it. */
export function useCreateTerminalThread() {
  const createThread = useOrchestrationCommand(threadEnvironment.create);
  const navigate = useNavigate();
  return async (projectRef: ScopedProjectRef) => {
    const threadId = newThreadId();
    const result = await createThread({
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
    if (result._tag === "Failure") return;
    await waitForStartedServerThread(scopeThreadRef(projectRef.environmentId, threadId));
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: projectRef.environmentId, threadId },
    });
  };
}
