import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../../serverSettings.ts";
import * as KitshnGrants from "./KitshnGrants.ts";

/** The kitshn map name of this machine while the setting asks for it, else the upstream label. */
export function kitshnEnvironmentLabel(
  upstreamLabel: string,
  enabled: boolean,
  machineName: string | null,
) {
  const name = machineName?.trim();
  return enabled && name ? name : upstreamLabel;
}

export const withKitshnMachineLabel = Effect.fn("KitshnGrants.withKitshnMachineLabel")(function* (
  descriptor: Effect.Effect<ExecutionEnvironmentDescriptor>,
) {
  const grants = yield* Effect.serviceOption(KitshnGrants.KitshnGrants);
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  if (Option.isNone(grants) || Option.isNone(settings)) return descriptor;
  return Effect.gen(function* () {
    const current = yield* descriptor;
    // The setting key keeps its map name, so saved settings stay valid.
    const enabled = yield* settings.value.getSettings.pipe(
      Effect.map((value) => value.environmentLabelFromMachineMap),
      Effect.orElseSucceed(() => false),
    );
    const machine = yield* grants.value.machine;
    return {
      ...current,
      label: kitshnEnvironmentLabel(current.label, enabled, machine?.name ?? null),
    };
  });
});
