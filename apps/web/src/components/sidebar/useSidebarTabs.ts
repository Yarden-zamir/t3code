/**
 * Fork: the state of the sidebar thread tabs, kept out of `Sidebar.tsx` so that the upstream
 * file changes little. The tabs live in the server setting `sidebarTabs` of the primary
 * environment, and the machine map owns their sync: a change saves on the primary, then becomes
 * the shared value of the map (MM-411), which every machine applies.
 */
import type { SidebarTab, SidebarTabRuleField, SidebarTabs } from "@t3tools/contracts";
import { effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { randomUUID } from "~/lib/utils";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  useClientSettings,
  usePrimarySettings,
  usePrimarySettingsAvailable,
} from "../../hooks/useSettings";
import { useShareServerSettingsToMachineMap } from "../../machineMap/shareSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  filterSidebarV2VisibleThreads,
  hasUnseenCompletion,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { toastManager } from "../ui/toast";
import { filterSidebarThreadsByOwner } from "./ownerFilter.logic";
import { useSidebarTabStore } from "./sidebarTabStore";
import {
  buildSidebarTabProjectFacts,
  buildSidebarTabRuleOptions,
  createSidebarTab,
  DEFAULT_SIDEBAR_TAB_ID,
  sidebarDefaultTabName,
  updateSidebarDefaultTab,
  deleteSidebarTab,
  compileSidebarTabs,
  moveSidebarTab,
  moveSidebarThreads,
  pruneSidebarTabAssignments,
  resolveSidebarTabStatus,
  resolveSidebarThreadTabId,
  SIDEBAR_TAB_ATTENTION_STATUSES,
  sidebarTabShowsThread,
  sidebarTabThreadKey,
  updateSidebarTab,
} from "./sidebarTabs.logic";
import { sidebarTabStatus, type SidebarTabStatus } from "./sidebarTabStatus";

/** The data attribute that marks a drop target in the tab bar: a tab id, or `new`. */
export const SIDEBAR_TAB_DROP_ATTRIBUTE = "data-sidebar-tab-drop";
export const SIDEBAR_TAB_DROP_NEW = "new";
/** The "more" button: a drag over it opens the menu of the tabs that do not fit. */
export const SIDEBAR_TAB_DROP_MORE = "more";

export interface SidebarTabItem {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly isView: boolean;
  /** An id of the tab icon set, `none`, or undefined for the default dot. */
  readonly icon: string | undefined;
  readonly showName: boolean;
  /** Threads that the tab shows, without the settled ones. */
  readonly threadCount: number;
  /** The status of the most urgent thread that is not asleep. */
  readonly status: SidebarTabStatus | null;
  readonly needsAttention: boolean;
  /** The one thread of the tab, when a click on the tab opens it. */
  readonly singleThread: SidebarThreadSummary | null;
}

const EMPTY_SETTINGS: SidebarTabs = { tabs: [], assignments: {}, defaultTab: {} };

const NO_TABS: readonly SidebarTabItem[] = [];

/**
 * The item of each tab. It reads the clock, so `clockKey` changes at each snooze wake and the
 * compiler builds the tabs again.
 */
function buildSidebarTabItems(input: {
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly localLastVisitedAt: ReadonlyArray<string | undefined>;
  readonly settings: SidebarTabs;
  readonly compiled: ReturnType<typeof compileSidebarTabs>;
  readonly showsThread: (tab: string, thread: SidebarThreadSummary) => boolean;
  readonly singleThreadOpens: boolean;
  readonly clockKey: number;
}): readonly SidebarTabItem[] {
  const { threads, localLastVisitedAt, settings, compiled, showsThread, singleThreadOpens } = input;
  const now = new Date().toISOString();
  const states = threads.map((thread, index) => {
    const lastVisitedAt = resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      localLastVisitedAt[index],
    );
    const wokeAt = threadWokeAt(thread, { now });
    const settled = thread.settledOverride === "settled";
    return {
      thread,
      settled,
      asleep: settled || effectiveSnoozed(thread, { now }),
      isUnread: hasUnseenCompletion({ ...thread, lastVisitedAt }),
      isWoke:
        wokeAt !== null &&
        !settled &&
        (lastVisitedAt === undefined || Date.parse(lastVisitedAt) < Date.parse(wokeAt)),
    };
  });
  const describe = (
    id: string,
    name: string,
    tab: SidebarTab | null,
    look: { readonly icon?: string | undefined; readonly showName?: boolean | undefined },
  ): SidebarTabItem => {
    const shown = states.filter((state) => showsThread(id, state.thread));
    const open = shown.filter((state) => !state.settled);
    const kind = resolveSidebarTabStatus(shown.filter((state) => !state.asleep));
    return {
      id,
      name,
      isDefault: tab === null,
      isView: tab !== null && compiled.byId.get(tab.id)?.isView === true,
      icon: look.icon,
      showName: look.showName !== false,
      threadCount: open.length,
      status: kind === null ? null : sidebarTabStatus(kind),
      needsAttention: kind !== null && SIDEBAR_TAB_ATTENTION_STATUSES.has(kind),
      singleThread: singleThreadOpens && tab !== null && open.length === 1 ? open[0]!.thread : null,
    };
  };
  return [
    describe(DEFAULT_SIDEBAR_TAB_ID, sidebarDefaultTabName(settings), null, settings.defaultTab),
    ...settings.tabs.map((tab) => describe(tab.id, tab.name, tab, tab)),
  ];
}

export function useSidebarTabs(input: {
  /** Every thread shell, before any filter. */
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  /** Tasks linked environments run for a listed thread; they show under it. */
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly ownerVisibleProjectKeys: ReadonlySet<string> | null;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly routeThreadKey: string | null;
  /** Search covers every tab. */
  readonly searching: boolean;
  /** Changes at each snooze wake, so the tab statuses see woken threads. */
  readonly snoozeWakeTick: number;
}) {
  const { routeThreadKey, searching, snoozeWakeTick } = input;
  const enabledOnDevice = useClientSettings((s) => s.sidebarTabsEnabled);
  // The hosted app has no primary server to hold the tabs, so it shows none.
  const primaryAvailable = usePrimarySettingsAvailable();
  const enabled = enabledOnDevice && primaryAvailable;
  const savedSettings = usePrimarySettings((s) => s.sidebarTabs);
  // Until the primary config arrives, the tabs read as empty, and every thread is in no tab.
  const ready = useAtomValue(primaryServerConfigAtom) !== null;
  const singleThreadOpens = useClientSettings((s) => s.sidebarTabSingleThreadOpens);
  const settings = enabled ? savedSettings : EMPTY_SETTINGS;
  const storedTabId = useSidebarTabStore((s) => s.tabId);
  const setTabId = useSidebarTabStore((s) => s.setTabId);
  const tabId =
    enabled && settings.tabs.some((tab) => tab.id === storedTabId)
      ? storedTabId
      : DEFAULT_SIDEBAR_TAB_ID;

  const projects = buildSidebarTabProjectFacts(input.projects);
  // Non-archived sidebar threads: what the tabs hold and what an assignment can name.
  const liveThreads = filterSidebarV2VisibleThreads(
    input.threads,
    null,
    input.delegatedUnderParent,
  );
  const threads = filterSidebarV2VisibleThreads(
    filterSidebarThreadsByOwner(input.threads, input.ownerVisibleProjectKeys),
    input.scopedProjectKeys,
    input.delegatedUnderParent,
  );

  // Known rules and view flags, once per change of the tabs, not once per thread.
  const compiled = compileSidebarTabs(settings);
  const tabIdByThreadKey = new Map(
    threads.map((thread) => [
      sidebarTabThreadKey(thread),
      resolveSidebarThreadTabId(thread, compiled, projects),
    ]),
  );

  const showsThread = (tab: string, thread: SidebarThreadSummary) =>
    sidebarTabShowsThread({
      tabId: tab,
      thread,
      threadTabId: tabIdByThreadKey.get(sidebarTabThreadKey(thread)) ?? DEFAULT_SIDEBAR_TAB_ID,
      compiled,
      projects,
    });

  /** The threads of the open tab. Search and a disabled feature see every thread. */
  const visibleThreads =
    !enabled || searching ? threads : threads.filter((thread) => showsThread(tabId, thread));

  // A tab switch drops the selection, like a scope flip: hidden rows must not stay selected.
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const previousTabIdRef = useRef(tabId);
  useEffect(() => {
    if (previousTabIdRef.current === tabId) return;
    previousTabIdRef.current = tabId;
    clearSelection();
  }, [clearSelection, tabId]);

  // Unread and woke are row-local elsewhere; the tabs need them for every thread.
  const localLastVisitedAt = useUiStateStore(
    useShallow((state) =>
      enabled
        ? threads.map((thread) => state.threadLastVisitedAtById[sidebarTabThreadKey(thread)])
        : [],
    ),
  );

  const tabs = enabled
    ? buildSidebarTabItems({
        threads,
        localLastVisitedAt,
        settings,
        compiled,
        showsThread,
        singleThreadOpens,
        clockKey: snoozeWakeTick,
      })
    : NO_TABS;

  // Opening a thread from a link, a notification or a new-thread action shows its tab, so the
  // open row is visible. Browsing other tabs while the thread stays open does not switch back.
  // It waits for the tabs: before they load, every thread resolves to the default tab.
  const followedRouteKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !ready || routeThreadKey === null) return;
    if (followedRouteKeyRef.current === routeThreadKey) return;
    const thread = threads.find((candidate) => sidebarTabThreadKey(candidate) === routeThreadKey);
    if (thread === undefined) return;
    followedRouteKeyRef.current = routeThreadKey;
    if (showsThread(tabId, thread)) return;
    const threadTabId = tabIdByThreadKey.get(routeThreadKey) ?? DEFAULT_SIDEBAR_TAB_ID;
    // A single-thread tab stands for its thread, so it is visible without a switch.
    if (tabs.some((tab) => tab.id === threadTabId && tab.singleThread !== null)) return;
    setTabId(threadTabId);
  }, [
    enabled,
    tabIdByThreadKey,
    ready,
    routeThreadKey,
    setTabId,
    showsThread,
    tabId,
    tabs,
    threads,
  ]);

  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const persist = useAtomCommand(serverEnvironment.updateSettings, {
    label: "sidebar tabs update",
    reportFailure: false,
  });
  const shareToMachineMap = useShareServerSettingsToMachineMap();
  // Each write replaces the tabs whole. Two quick edits chain through this ref, so the second
  // does not undo the first before the server echoes it. Edits from two devices at the same
  // moment still keep only the last one; revisit with per-tab commands if that bites.
  const latestSettingsRef = useRef(savedSettings);
  const savedSettingsRef = useRef(savedSettings);
  useEffect(() => {
    latestSettingsRef.current = savedSettings;
    savedSettingsRef.current = savedSettings;
  }, [savedSettings]);
  const update = (change: (current: SidebarTabs) => SidebarTabs) => {
    if (primaryEnvironmentId === null || !ready) return;
    const current = latestSettingsRef.current;
    const next = pruneSidebarTabAssignments(change(current), liveThreads);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    latestSettingsRef.current = next;
    void persist({
      environmentId: primaryEnvironmentId,
      input: { patch: { sidebarTabs: next } },
    }).then((result) => {
      if (result._tag === "Success") {
        shareToMachineMap(primaryEnvironmentId, ["sidebarTabs"]);
        return;
      }
      // The next edit starts from the saved tabs, not from the edit that failed. An edit made
      // on top of it in the meantime stays: its own save reports its own result.
      if (latestSettingsRef.current === next) latestSettingsRef.current = savedSettingsRef.current;
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Tabs not saved",
        description: error instanceof Error ? error.message : "Try reconnecting and saving again.",
      });
    });
  };

  const threadsForRefs = (threadKeys: readonly string[]) => {
    const keys = new Set(threadKeys);
    return liveThreads.filter((thread) => keys.has(sidebarTabThreadKey(thread)));
  };

  /** The id of the new tab, or null before the tabs load, when no edit can save. */
  const createTab = (threadKeys: readonly string[]): string | null => {
    if (!ready) return null;
    const id = randomUUID();
    update((current) =>
      moveSidebarThreads(createSidebarTab(current, id), threadsForRefs(threadKeys), id, projects),
    );
    setTabId(id);
    return id;
  };

  // The tab or the new-tab area under a dragged thread. A view takes no drop: it holds no threads.
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const dropTargetAt = (point: { x: number; y: number }) => {
    // Before the tabs load, no edit can save, so the tab bar takes no drop.
    if (!enabled || !ready) return null;
    const target =
      document
        .elementFromPoint(point.x, point.y)
        ?.closest(`[${SIDEBAR_TAB_DROP_ATTRIBUTE}]`)
        ?.getAttribute(SIDEBAR_TAB_DROP_ATTRIBUTE) ?? null;
    return target === SIDEBAR_TAB_DROP_NEW ||
      target === SIDEBAR_TAB_DROP_MORE ||
      tabsRef.current.some((tab) => tab.id === target && !tab.isView)
      ? target
      : null;
  };
  /** Tracks the drop target under a dragged thread. True when the tab bar takes the move. */
  const moveDrag = useStableCallback((point: { x: number; y: number }) => {
    const target = dropTargetAt(point);
    setDropTargetId(target);
    return target !== null;
  });
  /** Drops dragged threads on the tab bar. True when the tab bar took the drop. */
  const dropDrag = useStableCallback(
    (point: { x: number; y: number }, threadKeys: readonly string[]) => {
      const target = dropTargetAt(point);
      setDropTargetId(null);
      if (target === null) return false;
      // A drop on the "more" button itself moves nothing: the open menu holds the targets.
      if (target === SIDEBAR_TAB_DROP_MORE) return true;
      if (target === SIDEBAR_TAB_DROP_NEW) createTab(threadKeys);
      else
        update((current) =>
          moveSidebarThreads(current, threadsForRefs(threadKeys), target, projects),
        );
      return true;
    },
  );
  const endDrag = useStableCallback(() => setDropTargetId(null));

  // The empty list of a tab says why it is empty. The default tab keeps the upstream text.
  const openTab = compiled.byId.get(tabId);
  const emptyMessage =
    !enabled || openTab === undefined
      ? null
      : openTab.rules.length > 0
        ? "No threads match the rules"
        : "Drag threads onto this tab";

  const ruleOptions = (field: Exclude<SidebarTabRuleField, "title">, id: string) =>
    buildSidebarTabRuleOptions({ field, tabId: id, threads, projects, settings });

  const renameTab = (id: string, name: string) => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    update((current) => updateSidebarTab(current, id, (tab) => ({ ...tab, name: trimmed })));
  };
  const setTabRules = (id: string, rules: SidebarTab["rules"]) =>
    update((current) => updateSidebarTab(current, id, (tab) => ({ ...tab, rules })));
  const setDefaultTab = (change: (tab: SidebarTabs["defaultTab"]) => SidebarTabs["defaultTab"]) =>
    update((current) => updateSidebarDefaultTab(current, change));
  const setTabLook = (id: string, look: { readonly icon?: string; readonly showName?: boolean }) =>
    update((current) => updateSidebarTab(current, id, (tab) => ({ ...tab, ...look })));
  const deleteTab = (id: string) => update((current) => deleteSidebarTab(current, id));
  const moveTab = (id: string, toIndex: number) =>
    update((current) => moveSidebarTab(current, id, toIndex));

  return {
    enabled,
    /** The tabs have loaded, so edits can save. */
    ready,
    emptyMessage,
    settings,
    tabId,
    setTabId,
    tabs,
    visibleThreads,
    ruleOptions,
    dropTargetId,
    moveDrag,
    dropDrag,
    endDrag,
    createTab,
    renameTab,
    setTabRules,
    setTabLook,
    setDefaultTab,
    deleteTab,
    moveTab,
  };
}

export type SidebarTabsState = ReturnType<typeof useSidebarTabs>;
