import { useAtomValue } from "@effect/atom-react";
import { createReadableThreadEnvironmentAtoms } from "@t3tools/client-runtime/state/readableThreadEnvironments";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type MachineMapClientState, WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

/** Fork: this server's kitshn client state, pushed whole again on each change. */
const machineMapState = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:machine-map:state",
  tag: WS_METHODS.machineMapSubscribe,
  // The last reader that unmounts ends the stream at once. The server sends the whole state again.
  idleTtlMs: 0,
});

/** MM-411 on kitshn: a change saved for all environments goes into the shared `t3.settings`. */
export const shareMachineMapSettings = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:machine-map:share-settings",
  tag: WS_METHODS.machineMapShareSettings,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});

export function useMachineMapState(environmentId: EnvironmentId | null): {
  readonly state: MachineMapClientState | null;
  readonly error: string | null;
} {
  const query = useEnvironmentQuery(
    environmentId === null ? null : machineMapState({ environmentId, input: {} }),
  );
  return { state: query.data, error: query.error };
}

/** K-1609: this environment and the machines that its kitshn links reach, for the Machines panel. */
export const linkedMachines = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kitshn:linked-machines",
  tag: WS_METHODS.machineMapReadableEnvironments,
  staleTimeMs: 15_000,
  idleTtlMs: 30_000,
});
const readableThreadEnvironmentAtoms = createReadableThreadEnvironmentAtoms(connectionAtomRuntime);

/** MM-1906: the readable environment ids of each environment in `environmentIds`. */
export function useReadableEnvironmentIdsByEnvironment(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<EnvironmentId, ReadonlyArray<EnvironmentId>> {
  return useAtomValue(
    readableThreadEnvironmentAtoms.readableIdsByEnvironment(environmentIds.join("\u0000")),
  );
}
