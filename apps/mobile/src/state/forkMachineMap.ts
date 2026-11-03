import {
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** Fork: the machine map state of one environment. The server sends it whole on each change. */
export const machineMapState = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "mobile:fork:machine-map-state",
  tag: WS_METHODS.machineMapSubscribe,
  // The last reader that unmounts ends the stream at once, not after the idle time.
  idleTtlMs: 0,
});

/** Fork: the Fleet view. The kitshn daemon of the machine of one environment. */
export const fleetDaemon = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:fork:fleet-daemon",
  tag: WS_METHODS.fleetDaemon,
  staleTimeMs: 60_000,
  idleTtlMs: 120_000,
});
