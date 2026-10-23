/**
 * Fork: the open sidebar tab on mobile. A tap opens the tab in memory, so it renders only the
 * screens that show the tabs. The phone stores the tab in its preferences later, off the tap
 * path, because that write renders every reader of the preferences.
 */
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { updateMobilePreferencesAtom } from "./preferences";

/** The tab that this app session opened last, or null before the first tap. */
export const selectedSidebarTabIdAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:fork-sidebar-tab-selected"),
);

// Known limit: a tab that the user opens less than this before the app closes is not stored.
// Revisit if users report that the phone forgets the open tab.
export const STORE_SELECTED_SIDEBAR_TAB_DELAY_MS = 1_000;
let storeTimer: ReturnType<typeof setTimeout> | undefined;

/** Opens a tab at once. Quick taps through the tabs store only the last tab. */
export function selectSidebarTab(tabId: string): void {
  appAtomRegistry.set(selectedSidebarTabIdAtom, tabId);
  clearTimeout(storeTimer);
  storeTimer = setTimeout(
    () => appAtomRegistry.set(updateMobilePreferencesAtom, { sidebarTabId: tabId }),
    STORE_SELECTED_SIDEBAR_TAB_DELAY_MS,
  );
}
