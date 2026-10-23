import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

vi.mock("./preferences", () => ({
  updateMobilePreferencesAtom: Atom.make<object | null>(null),
}));

import { appAtomRegistry } from "./atom-registry";
import {
  STORE_SELECTED_SIDEBAR_TAB_DELAY_MS,
  selectedSidebarTabIdAtom,
  selectSidebarTab,
} from "./forkSidebarTabSelection";
import { updateMobilePreferencesAtom } from "./preferences";

it("opens a tab at once and stores only the last of quick taps, after the tap", () => {
  vi.useFakeTimers();
  const writes: unknown[] = [];
  const unsubscribe = appAtomRegistry.subscribe(updateMobilePreferencesAtom, (write) => {
    writes.push(write);
  });

  selectSidebarTab("tab-a");
  selectSidebarTab("tab-b");

  expect(appAtomRegistry.get(selectedSidebarTabIdAtom)).toBe("tab-b");
  expect(writes).toEqual([]);
  vi.advanceTimersByTime(STORE_SELECTED_SIDEBAR_TAB_DELAY_MS);
  expect(writes).toEqual([{ sidebarTabId: "tab-b" }]);
  unsubscribe();
  vi.useRealTimers();
});
