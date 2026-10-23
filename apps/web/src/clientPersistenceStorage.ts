import {
  ClientSettingsSchema,
  moveLegacySidebarTabKeys,
  type ClientSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";
const StoredClientSettings = Schema.Record(Schema.String, Schema.Unknown);

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  // Fork: the sidebar tab settings move once from their old keys.
  const stored = getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, StoredClientSettings);
  const moved = stored === null ? null : moveLegacySidebarTabKeys("client", stored);
  if (moved !== null) {
    setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, moved, StoredClientSettings);
  }
  return getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}
