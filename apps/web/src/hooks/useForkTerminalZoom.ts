import type { ClientSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isMacPlatform } from "../lib/utils";
import { useClientSettings } from "./useSettings";
import { useLocalStorage } from "./useLocalStorage";

const ZOOM_STORAGE_KEY = "t3code:terminal-font-delta";
const selectZoomLimits = (settings: ClientSettings) => ({
  min: settings.terminalThreadFontSizeMin,
  max: settings.terminalThreadFontSizeMax,
});

export type TerminalZoom = "in" | "out" | "reset";

/** Fork: `cmd+=`, `cmd+-` and `cmd+0` on macOS, `ctrl+=`, `ctrl+-` and `ctrl+0` elsewhere. */
export function terminalZoomShortcut(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): TerminalZoom | null {
  if (event.altKey) return null;
  const mac = isMacPlatform(navigator.platform);
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  if (event.key === "0") return "reset";
  if (event.key === "-" || event.key === "_") return "out";
  if (event.key === "=" || event.key === "+") return "in";
  return null;
}

/**
 * Fork: the zoom of every terminal surface, the terminal thread and the drawer alike. One stored
 * offset from the font size setting, kept inside the limits `terminalThreadFontSizeMin` and
 * `terminalThreadFontSizeMax`.
 */
export function useTerminalZoom(baseFontSize: number) {
  const limits = useClientSettings(selectZoomLimits);
  const [delta, setDelta] = useLocalStorage(ZOOM_STORAGE_KEY, 0, Schema.Int);
  const clamp = (size: number) => Math.min(limits.max, Math.max(limits.min, size));
  return {
    fontSize: clamp(baseFontSize + delta),
    zoom: (action: TerminalZoom) => {
      const next = clamp(baseFontSize + delta + (action === "in" ? 1 : -1));
      setDelta(action === "reset" ? 0 : next - baseFontSize);
    },
  };
}
