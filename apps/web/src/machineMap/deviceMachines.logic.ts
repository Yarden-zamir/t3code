/** Fork: the desktop app's machines from its kitshn device token (K-1617), as pure decisions. */
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

export interface SavedEnvironment {
  readonly environmentId: EnvironmentId;
  /** The http(s) origin of its saved route, or null. */
  readonly origin: string | null;
  readonly phase: EnvironmentConnectionPhase;
}

export interface DeviceMachinesPlan {
  /** Listed origins that this app manages: they keep the device token. */
  readonly keep: ReadonlyArray<string>;
  /** Listed origins to pair: not saved yet, or saved and refused. The caller backs off. */
  readonly pair: ReadonlyArray<string>;
  /** Managed origins that the list dropped: remove their environment and token. */
  readonly remove: ReadonlyArray<{
    readonly origin: string;
    readonly environmentId: EnvironmentId | null;
  }>;
}

/**
 * Decides which machines to add, pair again and remove. Only `managed`, the origins this app
 * added, ever go, so a hand-saved environment stays. An empty list says nothing about access,
 * for example before cards have addresses, so it removes nothing.
 */
export function planDeviceMachines(input: {
  readonly listed: ReadonlyArray<string>;
  readonly managed: ReadonlySet<string>;
  readonly saved: ReadonlyArray<SavedEnvironment>;
}): DeviceMachinesPlan {
  const savedByOrigin = new Map(
    input.saved.flatMap((environment) =>
      environment.origin === null ? [] : [[environment.origin, environment] as const],
    ),
  );
  const listed = new Set(input.listed);
  const keep: Array<string> = [];
  const pair: Array<string> = [];
  for (const origin of listed) {
    const saved = savedByOrigin.get(origin);
    if (saved !== undefined && !input.managed.has(origin)) continue;
    keep.push(origin);
    if (saved === undefined || saved.phase === "error") pair.push(origin);
  }
  const remove =
    listed.size === 0
      ? []
      : [...input.managed]
          .filter((origin) => !listed.has(origin))
          .map((origin) => ({
            origin,
            environmentId: savedByOrigin.get(origin)?.environmentId ?? null,
          }));
  return { keep, pair, remove };
}
