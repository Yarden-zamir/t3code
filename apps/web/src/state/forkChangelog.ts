import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Fork changelog reads. The server asks GitHub, so each read costs GitHub quota: results stay
 * fresh for a minute and drop soon after the changelog closes.
 */
export const forkReleases = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-changelog:releases",
  tag: WS_METHODS.forkChangelogListReleases,
  staleTimeMs: 60_000,
  idleTtlMs: 60_000,
});

/** A published release does not change, so its changes stay fresh while the app runs. */
export const forkReleaseChanges = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-changelog:release-changes",
  tag: WS_METHODS.forkChangelogReleaseChanges,
  staleTimeMs: Number.POSITIVE_INFINITY,
  idleTtlMs: 10 * 60_000,
});

export const forkUpstreamPending = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-changelog:upstream-pending",
  tag: WS_METHODS.forkChangelogUpstreamPending,
  staleTimeMs: 60_000,
  idleTtlMs: 60_000,
});
