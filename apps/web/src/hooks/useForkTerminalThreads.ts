import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironments } from "../state/environments";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";

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

/** Fork: whether a connected environment has `terminalThreads` on, read at event time. */
export function readTerminalThreadsAvailable(): boolean {
  for (const presentation of appAtomRegistry
    .get(environmentPresentations.presentationsAtom)
    .values()) {
    if (presentation.serverConfig?.settings.terminalThreads === true) return true;
  }
  return false;
}

/** Fork: a draft can switch to Terminal mode: the server allows it and so do the grants. */
export function useTerminalModeAvailable(environmentId: EnvironmentId | null): boolean {
  const enabled = useTerminalThreadsEnabled(environmentId);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canCreateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  return enabled && canOperateTerminal && canCreateThread;
}
