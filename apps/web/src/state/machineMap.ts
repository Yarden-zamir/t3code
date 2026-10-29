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

/**
 * Fork: machine map (apps/machine-map/SPEC.md). The server pushes its whole client state again
 * on each change. Only the local desktop app gets `tokenHeaders` and `desktopCommands`.
 */
const machineMapState = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:machine-map:state",
  tag: WS_METHODS.machineMapSubscribe,
  // The last reader that unmounts ends the stream at once, for example access change notices that
  // were turned off. The server sends the whole state again on the next subscribe.
  idleTtlMs: 0,
});

export const reportMachineMapDesktop = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:machine-map:report-desktop",
  tag: WS_METHODS.machineMapReportDesktop,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});

/** MM-411: a change saved for all environments becomes the shared value of the map. */
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

/**
 * MM-1701: the map for the Machines panel. Each read is one portal call, so a result stays fresh
 * for 15 seconds and drops soon after the panel closes.
 */
export const machinesRead = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:machine-map:read",
  tag: WS_METHODS.machineMapRead,
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
