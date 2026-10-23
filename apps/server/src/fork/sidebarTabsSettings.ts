/**
 * Fork: `settings.json` from before sidebar tabs were called groups holds `sidebarGroups` and
 * `mobileSidebarGroups`. They move once to their new keys when the server reads the file.
 */
import { moveLegacySidebarTabKeys } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Schema from "effect/Schema";

const SettingsObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeSettingsObject = Schema.decodeUnknownExit(fromLenientJson(SettingsObject));
const encodeSettingsObject = Schema.encodeSync(Schema.fromJsonString(SettingsObject));

/**
 * The file text with the old keys moved, and whether a key moved. Text that is not a JSON object
 * stays as it is, so the settings decode reports it as before.
 */
export function moveLegacySidebarTabSettings(raw: string): {
  readonly raw: string;
  readonly moved: boolean;
} {
  const decoded = decodeSettingsObject(raw);
  if (decoded._tag === "Failure") return { raw, moved: false };
  const moved = moveLegacySidebarTabKeys("server", decoded.value);
  return moved === null ? { raw, moved: false } : { raw: encodeSettingsObject(moved), moved: true };
}
