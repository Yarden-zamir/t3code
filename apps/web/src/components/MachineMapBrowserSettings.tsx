import {
  type AppliedSharedSettings,
  sharedSettingsToApply,
} from "@t3tools/client-runtime/fork/sharedClientSettings";
import type { EnvironmentId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent } from "react";

import {
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsPatch,
} from "../hooks/useSettings";
import {
  clientSettingsPatchFromDesired,
  withoutDesktopOnlyClientSettings,
} from "../machineMap/desktopSync.logic";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useMachineMapState } from "../state/machineMap";

const APPLIED_KEY = "t3code:machine-map:applied-client-settings";
const decodeApplied = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

function readApplied(): AppliedSharedSettings {
  const raw = globalThis.localStorage.getItem(APPLIED_KEY);
  if (raw === null) return {};
  const decoded = decodeApplied(raw);
  if (decoded._tag === "None") throw new Error(`${APPLIED_KEY} holds an invalid value.`);
  return decoded.value;
}

/**
 * Fork, MM-416: a browser takes the shared client settings of the machine that serves it, from
 * the map state that its connection already streams. The desktop app follows MM-403 instead.
 */
export function MachineMapBrowserSettings() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? null : <BrowserSettingsSync environmentId={environmentId} />;
}

function BrowserSettingsSync({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { state } = useMachineMapState(environmentId);
  // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- the client settings scope, not an RPC client.
  const desiredClient = state?.desired?.settings.client ?? null;
  const desiredKey = stableStringify(desiredClient);

  const apply = useEffectEvent(async () => {
    if (desiredClient === null) return;
    const { changed, applied } = sharedSettingsToApply(
      withoutDesktopOnlyClientSettings(desiredClient),
      readApplied(),
    );
    if (Object.keys(changed).length > 0) {
      // Before hydration the snapshot holds the defaults, not the saved settings.
      await ensureClientSettingsHydrated();
      const { patch, skipped } = clientSettingsPatchFromDesired(changed, getClientSettings());
      if (skipped.length > 0) {
        console.warn("Machine map: skipped client settings that do not apply here.", skipped);
      }
      if (Object.keys(patch).length > 0) await persistClientSettingsPatch(patch);
    }
    globalThis.localStorage.setItem(APPLIED_KEY, JSON.stringify(applied));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies pushed map values to storage, outside React.
  useEffect(() => {
    void apply();
    // The key stands for the desired values, which arrive as a new object on each push.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The key is the trigger.
  }, [desiredKey]);

  return null;
}
