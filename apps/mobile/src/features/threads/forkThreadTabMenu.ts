/**
 * Fork: "Assign to tab" in the long-press menu of a thread row, the touch way to what a drag onto
 * a tab does on web. It shows while a connected server has `mobileSidebarTabs` on.
 */
import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  buildSidebarTabProjectFacts,
  compileSidebarTabs,
  DEFAULT_SIDEBAR_TAB_ID,
  moveSidebarThreads,
  sidebarDefaultTabName,
} from "@t3tools/client-runtime/state/sidebarTabs";
import type { SidebarTabs } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  createMobileSidebarTab,
  editSidebarTabs,
  openSidebarTabEditor,
  sidebarTabsAtom,
} from "../../state/forkSidebarTabs";
import { environmentProjects } from "../../state/projects";

const ASSIGN_PREFIX = "fork-tab:";
const NEW_TAB_EVENT = `${ASSIGN_PREFIX}new`;
const NO_ITEMS: MenuAction[] = [];

/** The tabs that can hold threads: the first tab and every tab that is not a view. */
function assignMenuItems(settings: SidebarTabs): MenuAction[] {
  const compiled = compileSidebarTabs(settings);
  return [
    {
      id: "fork-tab",
      title: "Assign to tab",
      image: "folder",
      subactions: [
        { id: `${ASSIGN_PREFIX}${DEFAULT_SIDEBAR_TAB_ID}`, title: sidebarDefaultTabName(settings) },
        ...settings.tabs
          .filter((tab) => compiled.byId.get(tab.id)?.isView !== true)
          .map((tab) => ({ id: `${ASSIGN_PREFIX}${tab.id}`, title: tab.name })),
        { id: NEW_TAB_EVENT, title: "New tab…", image: "plus" },
      ],
    },
  ];
}

/**
 * The menu items, and the handler that returns true for an event it took. The items depend on
 * the tabs alone, so every row shares the same work per change of the tabs.
 */
export function useThreadTabMenu(thread: EnvironmentThreadShell): {
  readonly items: MenuAction[];
  readonly handle: (event: string) => boolean;
} {
  const settings = useAtomValue(sidebarTabsAtom);
  const navigation = useNavigation();
  const items = useMemo(
    () => (settings === null ? NO_ITEMS : assignMenuItems(settings)),
    [settings],
  );
  const handle = useCallback(
    (event: string) => {
      if (!event.startsWith(ASSIGN_PREFIX)) return false;
      // Read once at the tap, so the rows do not subscribe to the projects.
      const facts = buildSidebarTabProjectFacts(
        appAtomRegistry.get(environmentProjects.projectsAtom),
      );
      if (event === NEW_TAB_EVENT) {
        const id = createMobileSidebarTab((current, tabId) =>
          moveSidebarThreads(current, [thread], tabId, facts),
        );
        openSidebarTabEditor(navigation, id);
        return true;
      }
      const tabId = event.slice(ASSIGN_PREFIX.length);
      editSidebarTabs((current) => moveSidebarThreads(current, [thread], tabId, facts));
      return true;
    },
    [navigation, thread],
  );
  return { items, handle };
}
