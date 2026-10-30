/** Fork: the client settings of `t3.settings` on kitshn (K-709), as pure decisions. */
import { ClientSettingsPatch, type ClientSettings, type SettingValues } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Schema from "effect/Schema";

const isClientSettingsPatch = Schema.is(ClientSettingsPatch);

/**
 * MM-403: the part of the desired client settings that differs from the current ones. A value
 * that is already current is left out, so applying the map's own value writes nothing and the
 * next push changes nothing. Keys that are not client settings, or have an invalid value, are
 * in `skipped`.
 */
export function clientSettingsPatchFromDesired(
  desired: SettingValues,
  current: ClientSettings,
): { readonly patch: ClientSettingsPatch; readonly skipped: ReadonlyArray<string> } {
  const patch: Record<string, unknown> = {};
  const skipped: Array<string> = [];
  const currentValues: Readonly<Record<string, unknown>> = current;
  for (const [key, value] of Object.entries(desired)) {
    if (
      !Object.hasOwn(ClientSettingsPatch.fields, key) ||
      !isClientSettingsPatch({ [key]: value })
    ) {
      skipped.push(key);
      continue;
    }
    if (stableStringify(currentValues[key]) !== stableStringify(value)) patch[key] = value;
  }
  if (!isClientSettingsPatch(patch)) {
    throw new Error("Each kitshn client setting passed its check, but the patch did not.");
  }
  return { patch, skipped };
}

/**
 * MM-416: client settings that only the desktop app uses. A browser does not take their shared
 * values. The settings view marks the same ones as "Only available in the desktop app."
 */
const DESKTOP_ONLY_CLIENT_SETTINGS = [
  "appToggleShortcuts",
  "browserAutoShowFloatingPreview",
  "browserDefaultAppearance",
  "browserDefaultProfileId",
  "browserDefaultViewport",
  "browserDefaultZoomFactor",
  "browserLinkTarget",
  "browserProfiles",
  "browserRecordingFrameRate",
  "browserRecordingShowKeyPresses",
  "browserRecordingShowMousePresses",
  "checkNewerBeforeUpdateInstall",
  "confirmQuit",
] as const satisfies ReadonlyArray<keyof ClientSettings>;

const desktopOnlyClientSettings: ReadonlySet<string> = new Set(DESKTOP_ONLY_CLIENT_SETTINGS);

export function withoutDesktopOnlyClientSettings(values: SettingValues): SettingValues {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => !desktopOnlyClientSettings.has(key)),
  );
}
