import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "./atom-registry";
import { saveMobilePreferences } from "./preferences";

/**
 * Fork: saves a preferences update without waiting, as a write to the old update atom did. A
 * stable module function, so effects and callbacks can call it without a new dependency.
 */
export function saveMobilePreferencesInBackground(
  update: Parameters<typeof saveMobilePreferences.run>[1],
): void {
  void runAtomCommand(appAtomRegistry, saveMobilePreferences, update);
}
