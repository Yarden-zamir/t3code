import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { sharedSettingsToApply } from "@t3tools/client-runtime/fork/sharedClientSettings";
import { EnvironmentId, type SettingValues } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { mobilePreferencesFromSharedClientSettings } from "../../lib/forkSharedClientSettings";
import { useEnvironments } from "../../state/environments";
import { machineMapState } from "../../state/forkMachineMap";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/**
 * The shared client values of the first environment with a map state. The machine map syncs the
 * same shared values to every machine, so the first one decides, like the published themes.
 */
const firstSharedClientSettings = Atom.family((joinedIds: string) =>
  Atom.make((get): SettingValues | null => {
    for (const environmentId of joinedIds.split("\u0000")) {
      if (environmentId === "") continue;
      const result = get(
        machineMapState({ environmentId: EnvironmentId.make(environmentId), input: {} }),
      );
      // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- the client settings scope, not an RPC client.
      const desired = Option.getOrNull(AsyncResult.value(result))?.desired?.settings.client;
      if (desired !== undefined) return desired;
    }
    return null;
  }).pipe(Atom.withLabel("mobile:fork:shared-client-settings")),
);

/**
 * Fork, MM-416: the app takes the shared client settings that it has as preferences, from the
 * map state that its connections already stream.
 */
export function ForkSharedClientSettings() {
  const { environments } = useEnvironments();
  const desired = useAtomValue(
    firstSharedClientSettings(
      environments.map(({ environmentId }) => environmentId).join("\u0000"),
    ),
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);

  const applied = AsyncResult.isSuccess(preferences)
    ? (preferences.value.machineMapAppliedClientSettings ?? {})
    : null;
  const plan =
    desired === null || applied === null ? null : sharedSettingsToApply(desired, applied);
  const planKey = plan === null ? null : stableStringify(plan.applied);
  const appliedKey = applied === null ? null : stableStringify(applied);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes pushed map values to storage, outside React.
  useEffect(() => {
    if (plan === null || planKey === appliedKey) return;
    updatePreferences({
      ...mobilePreferencesFromSharedClientSettings(plan.changed),
      machineMapAppliedClientSettings: plan.applied,
    });
    // The keys stand for the plan, which is a new object on each render.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The keys are the trigger.
  }, [planKey, appliedKey, updatePreferences]);

  return null;
}
