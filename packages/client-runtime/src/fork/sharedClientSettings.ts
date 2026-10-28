/**
 * Fork: shared client settings on a browser or a phone (apps/machine-map/SPEC.md MM-416). Such a
 * device is not a machine of the map, so it reports nothing. A change on the device stays until
 * the shared value of that key changes again.
 */
import type { SettingValues } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";

/** For each shared key, the stable JSON of the value that this device applied last. */
export type AppliedSharedSettings = Readonly<Record<string, string>>;

/**
 * The shared values that changed since this device applied them, and the record to save after
 * they apply. A key without a shared value leaves the record, so its value stays on the device.
 */
export function sharedSettingsToApply(
  desired: SettingValues,
  applied: AppliedSharedSettings,
): { readonly changed: SettingValues; readonly applied: AppliedSharedSettings } {
  const changed: Record<string, unknown> = {};
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(desired)) {
    const json = stableStringify(value);
    next[key] = json;
    if (applied[key] !== json) changed[key] = value;
  }
  return { changed, applied: next };
}
