import { expect, it, vi } from "vite-plus/test";

const { saves } = vi.hoisted(() => ({ saves: [] as unknown[] }));
vi.mock("./forkSavePreferences", () => ({
  saveMobilePreferencesInBackground: (update: unknown) => saves.push(update),
}));

import { appAtomRegistry } from "./atom-registry";
import {
  STORE_SELECTED_SIDEBAR_TAB_DELAY_MS,
  selectedSidebarTabIdAtom,
  selectSidebarTab,
} from "./forkSidebarTabSelection";

it("opens a tab at once and stores only the last of quick taps, after the tap", () => {
  vi.useFakeTimers();

  selectSidebarTab("tab-a");
  selectSidebarTab("tab-b");

  expect(appAtomRegistry.get(selectedSidebarTabIdAtom)).toBe("tab-b");
  expect(saves).toEqual([]);
  vi.advanceTimersByTime(STORE_SELECTED_SIDEBAR_TAB_DELAY_MS);
  expect(saves).toEqual([{ sidebarTabId: "tab-b" }]);
  vi.useRealTimers();
});
