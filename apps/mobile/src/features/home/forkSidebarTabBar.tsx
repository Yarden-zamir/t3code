/**
 * Fork: the sidebar tabs of web, above the home thread list, while a connected server has
 * `mobileSidebarTabs` on. The tabs come from the server setting `sidebarTabs`, which the
 * machine map syncs, so web and mobile show the same tabs. Tap a tab to show its threads, and
 * long-press it to edit, move or delete it.
 *
 * Known limits: a thread link does not switch to the tab of the thread, and web theme icon packs
 * do not apply. Revisit if users open threads from links on the phone often.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  buildSidebarTabProjectFacts,
  compileSidebarTabs,
  deleteSidebarTab,
  moveSidebarTab,
  DEFAULT_SIDEBAR_TAB_ID,
  resolveSidebarTabStatus,
  resolveSidebarThreadTabId,
  sidebarDefaultTabName,
  sidebarTabShowsThread,
  sidebarTabThreadKey,
  type SidebarTabStatusKind,
} from "@t3tools/client-runtime/state/sidebarTabs";
import { effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";
import { Pressable, ScrollView } from "react-native";
import { useResolveClassNames } from "uniwind";

import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";

import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  createMobileSidebarTab,
  editSidebarTabs,
  openSidebarTabEditor,
  sidebarTabsAtom,
} from "../../state/forkSidebarTabs";
import { threadHasUnseenCompletion } from "../threads/threadListV2";
import { SidebarTabIcon } from "./forkTabIcons";

/** The icon and colour of the thread row status (`STATUS_LABEL_BY_STATUS` in thread-list-v2-items). */
const TAB_STATUS: Record<
  SidebarTabStatusKind,
  { readonly icon: AppSymbolName; readonly tint: string }
> = {
  approval: { icon: "exclamationmark.shield", tint: "accent-warning-foreground" },
  input: { icon: "questionmark.bubble", tint: "accent-adaptive-indigo-600-300" },
  working: { icon: "circle.dashed", tint: "accent-adaptive-sky-600-400" },
  waiting: { icon: "circle.dashed.inset.filled", tint: "accent-foreground-muted" },
  failed: { icon: "exclamationmark.circle", tint: "accent-danger-foreground" },
  limited: { icon: "exclamationmark.circle", tint: "accent-warning-foreground" },
  woke: { icon: "clock", tint: "accent-warning-foreground" },
  done: { icon: "checkmark.circle", tint: "accent-adaptive-emerald-700-300" },
};

export interface HomeSidebarTabItem {
  readonly id: string;
  readonly name: string;
  /** A web tab icon id, `none`, or undefined for the default dot. */
  readonly icon: string | undefined;
  readonly showName: boolean;
  /** Threads that the tab shows, without the settled ones. */
  readonly threadCount: number;
  /** The status of the most urgent thread that is not asleep. */
  readonly status: SidebarTabStatusKind | null;
}

export interface HomeSidebarTabs {
  readonly tabs: ReadonlyArray<HomeSidebarTabItem>;
  readonly tabId: string;
  readonly selectTab: (tabId: string) => void;
  /** The threads of the open tab. Search covers every tab, so it sees every thread. */
  readonly filterThreads: (
    threads: ReadonlyArray<EnvironmentThreadShell>,
  ) => ReadonlyArray<EnvironmentThreadShell>;
}

/**
 * The tabs and the filter of the open tab, or null while no server has tabs for the phone.
 * The work runs once per change of the tabs, the projects, the threads or the clock, not once
 * per row.
 */
export function useHomeSidebarTabs(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** The list scope, so the tab counts match the list. */
  readonly environmentId: EnvironmentId | null;
  /** `scopedProjectKey` of each scoped project, or null for every project. */
  readonly projectKeys: ReadonlySet<string> | null;
  readonly searching: boolean;
  /** The list clock, so the tabs see snoozed threads wake. Minute precision is enough for a tab. */
  readonly now: string;
}): HomeSidebarTabs | null {
  const { threads, projects, environmentId, projectKeys, searching, now } = input;
  const settings = useAtomValue(sidebarTabsAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const storedTabId = AsyncResult.isSuccess(preferences)
    ? preferences.value.sidebarTabId
    : undefined;
  const tabId =
    settings !== null && settings.tabs.some((tab) => tab.id === storedTabId)
      ? storedTabId!
      : DEFAULT_SIDEBAR_TAB_ID;

  const compiled = useMemo(
    () => (settings === null ? null : compileSidebarTabs(settings)),
    [settings],
  );
  const facts = useMemo(() => buildSidebarTabProjectFacts(projects), [projects]);
  const tabIdByThreadKey = useMemo(() => {
    if (compiled === null) return null;
    return new Map(
      threads.map((thread) => [
        sidebarTabThreadKey(thread),
        resolveSidebarThreadTabId(thread, compiled, facts),
      ]),
    );
  }, [compiled, facts, threads]);

  const showsThread = useCallback(
    (tab: string, thread: EnvironmentThreadShell) =>
      compiled !== null &&
      tabIdByThreadKey !== null &&
      sidebarTabShowsThread({
        tabId: tab,
        thread,
        threadTabId: tabIdByThreadKey.get(sidebarTabThreadKey(thread)) ?? DEFAULT_SIDEBAR_TAB_ID,
        compiled,
        projects: facts,
      }),
    [compiled, facts, tabIdByThreadKey],
  );

  const tabs = useMemo(() => {
    if (settings === null) return [];
    const states = threads
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.lineage.relationshipToParent !== "subagent" &&
          (environmentId === null || thread.environmentId === environmentId) &&
          (projectKeys === null ||
            projectKeys.has(scopedProjectKey(thread.environmentId, thread.projectId))),
      )
      .map((thread) => {
        const settled = thread.settledOverride === "settled";
        const wokeAt = threadWokeAt(thread, { now });
        return {
          thread,
          settled,
          asleep: settled || effectiveSnoozed(thread, { now }),
          isUnread: threadHasUnseenCompletion(thread),
          isWoke:
            wokeAt !== null &&
            !settled &&
            (thread.lastVisitedAt == null || Date.parse(thread.lastVisitedAt) < Date.parse(wokeAt)),
        };
      });
    const describe = (
      id: string,
      name: string,
      look: { readonly icon?: string | undefined; readonly showName?: boolean | undefined },
    ): HomeSidebarTabItem => {
      const shown = states.filter((state) => showsThread(id, state.thread));
      return {
        id,
        name,
        icon: look.icon,
        showName: look.showName !== false,
        threadCount: shown.filter((state) => !state.settled).length,
        status: resolveSidebarTabStatus(shown.filter((state) => !state.asleep)),
      };
    };
    return [
      describe(DEFAULT_SIDEBAR_TAB_ID, sidebarDefaultTabName(settings), settings.defaultTab),
      ...settings.tabs.map((tab) => describe(tab.id, tab.name, tab)),
    ];
  }, [environmentId, now, projectKeys, settings, showsThread, threads]);

  const selectTab = useCallback(
    (next: string) => savePreferences({ sidebarTabId: next }),
    [savePreferences],
  );
  const filterThreads = useCallback(
    (list: ReadonlyArray<EnvironmentThreadShell>) =>
      searching ? list : list.filter((thread) => showsThread(tabId, thread)),
    [searching, showsThread, tabId],
  );

  return useMemo(
    () => (settings === null ? null : { tabs, tabId, selectTab, filterThreads }),
    [filterThreads, selectTab, settings, tabId, tabs],
  );
}

export function HomeSidebarTabBar(props: { readonly sidebarTabs: HomeSidebarTabs }) {
  const { tabs, tabId, selectTab } = props.sidebarTabs;
  const navigation = useNavigation();
  const { color: selectedColor } = useResolveClassNames("text-foreground");
  const { color: mutedColor } = useResolveClassNames("text-foreground-muted");
  const positionCount = tabs.length - 1;
  const handleTabAction = (tab: HomeSidebarTabItem, position: number, event: string) => {
    if (event === "edit") openSidebarTabEditor(navigation, tab.id);
    if (event === "move-left") editSidebarTabs((s) => moveSidebarTab(s, tab.id, position - 1));
    if (event === "move-right") editSidebarTabs((s) => moveSidebarTab(s, tab.id, position + 1));
    if (event === "delete") {
      Dialog.confirm({
        title: `Delete ${tab.name}?`,
        message: "Its threads go back to the rules or to the first tab.",
        confirmText: "Delete",
        destructive: true,
        onConfirm: () => {
          if (tabId === tab.id) selectTab(DEFAULT_SIDEBAR_TAB_ID);
          editSidebarTabs((s) => deleteSidebarTab(s, tab.id));
        },
      });
    }
  };
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 px-4 pb-2"
      keyboardShouldPersistTaps="handled"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === tabId;
        const status = tab.status === null ? null : TAB_STATUS[tab.status];
        const position = index - 1;
        return (
          <Menu
            key={tab.id}
            shouldOpenOnLongPress
            actions={tabMenuActions(position, positionCount)}
            onPressAction={({ nativeEvent }) => handleTabAction(tab, position, nativeEvent.event)}
          >
            <Pressable
              accessibilityRole="tab"
              accessibilityLabel={`${tab.name}, ${tab.threadCount} threads`}
              accessibilityHint="Long-press to edit the tab"
              accessibilityState={{ selected }}
              onPress={() => selectTab(tab.id)}
              className={cn(
                "h-9 flex-row items-center gap-1.5 rounded-full px-3 active:opacity-70",
                selected ? "bg-subtle" : "bg-transparent",
              )}
            >
              <SidebarTabIcon
                icon={tab.icon}
                size={16}
                color={selected ? selectedColor : mutedColor}
              />
              {tab.showName || tab.icon === "none" ? (
                <AppText
                  className={cn(
                    "text-sm font-t3-medium",
                    selected ? "text-foreground" : "text-foreground-muted",
                  )}
                >
                  {tab.name}
                </AppText>
              ) : null}
              {status ? (
                <SymbolView name={status.icon} size={14} tintColorClassName={status.tint} />
              ) : tab.threadCount > 0 ? (
                <AppText className="text-xs text-foreground-muted">{tab.threadCount}</AppText>
              ) : null}
            </Pressable>
          </Menu>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New tab"
        onPress={() => {
          const id = createMobileSidebarTab();
          selectTab(id);
          openSidebarTabEditor(navigation, id);
        }}
        className="size-9 items-center justify-center rounded-full active:opacity-70"
      >
        <SymbolView name="plus" size={16} tintColorClassName="accent-foreground-muted" />
      </Pressable>
    </ScrollView>
  );
}

/** The long-press menu of a tab. The first tab has no position and cannot be deleted. */
function tabMenuActions(position: number, positionCount: number): MenuAction[] {
  const edit: MenuAction = { id: "edit", title: "Edit", image: "slider.horizontal.3" };
  if (position < 0) return [edit];
  return [
    edit,
    ...(position > 0 ? [{ id: "move-left", title: "Move left", image: "chevron.left" }] : []),
    ...(position < positionCount - 1
      ? [{ id: "move-right", title: "Move right", image: "chevron.right" }]
      : []),
    { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
  ];
}
