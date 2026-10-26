import { useAtomValue } from "@effect/atom-react";
import { useSyncExternalStore } from "react";

import { getActiveThemeFonts, subscribeToActiveThemeFonts } from "../forkThemeStyle";
import { subscribeAtomChanges } from "../rpc/atomRegistry";
import { environmentThemeDefinitionsAtom, type ThemeDefinition } from "../themePalette";
import { refreshTheme } from "./useTheme";

export function useEnvironmentThemeDefinitions(): ReadonlyArray<ThemeDefinition> {
  return useAtomValue(environmentThemeDefinitionsAtom);
}

/**
 * The palette is painted from a snapshot taken when the theme last changed, so new colors
 * only land if the active theme is re-applied.
 */
export function startEnvironmentThemeRepaint(): () => void {
  return subscribeAtomChanges(environmentThemeDefinitionsAtom, () => {
    refreshTheme({ preservePreview: true });
  });
}

/** Fonts the active theme suggests; empty when it suggests none. */
export function useActiveThemeFonts(): ReturnType<typeof getActiveThemeFonts> {
  return useSyncExternalStore(
    subscribeToActiveThemeFonts,
    getActiveThemeFonts,
    getActiveThemeFonts,
  );
}
