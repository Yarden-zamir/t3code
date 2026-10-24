/**
 * Fork: sidebar tabs above the sidebar list. A thread lives in one tab: the tab that the user
 * assigned it to, else the first tab whose rules match it, else the default tab. A tab with a
 * `tab` rule is a view: it shows the threads of other tabs and holds none itself, so a user can
 * build an "All" tab.
 */
import {
  isKnownSidebarTabRule,
  repositoryGroupingDisplayNameOf,
  repositoryGroupingKeyOf,
  repositoryOwnerOf,
  SidebarTabRuleField,
  type RepositoryIdentity,
  type SidebarTab,
  type SidebarTabRule,
  type SidebarTabs,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

export const DEFAULT_SIDEBAR_TAB_ID = "default";
export const DEFAULT_SIDEBAR_TAB_NAME = "Threads";

/** The name of the first tab: the user's name for it, or "Threads". */
export const sidebarDefaultTabName = (settings: Pick<SidebarTabs, "defaultTab">) =>
  settings.defaultTab.name ?? DEFAULT_SIDEBAR_TAB_NAME;

/** Whether the first tab shows every thread, not only the threads in no tab. */
const defaultTabShowsAll = (settings: Pick<SidebarTabs, "defaultTab">) =>
  settings.defaultTab.show === "all";

export type SidebarTabThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "providerInstanceId"
  | "pendingBackgroundTasks"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "runtime"
  | "pendingSubagentRequest"
> & { readonly source: Pick<EnvironmentThreadShell["source"], "createdBy"> };

/** The thread status that a `status` rule compares. */
export type SidebarTabThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

/**
 * The status that rules compare. It must stay equal to the list status of each client (web
 * `resolveSidebarThreadStatus`, mobile `resolveThreadListV2Status`), because a rule value saved
 * on one client must match the same threads on the other.
 */
function sidebarTabThreadStatus(
  thread: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest" | "runtime"
  >,
): SidebarTabThreadStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") return "approval";
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") return "input";
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") return "waiting";
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

/** The status that a tab shows: the most urgent thread status, with unread and woke threads. */
export type SidebarTabStatusKind =
  | "approval"
  | "done"
  | "failed"
  | "limited"
  | "input"
  | "waiting"
  | "woke"
  | "working";

/**
 * Project facts that rules compare, by `environmentId:projectId`. The repository key is the same
 * on every machine, unlike a project id, a path or the sidebar's project grouping, so a project
 * rule in the shared setting matches the same repository everywhere.
 */
interface SidebarTabProjectFacts {
  /** `repositoryGroupingKeyOf`, such as `github.com/yarden-zamir/t3code`. Null without a remote. */
  readonly repository: string | null;
  readonly repositoryLabel: string | null;
  readonly owner: string | null;
}

type SidebarTabProjectLookup = ReadonlyMap<string, SidebarTabProjectFacts>;

export function buildSidebarTabProjectFacts(
  projects: ReadonlyArray<{
    readonly environmentId: string;
    readonly id: string;
    readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  }>,
): SidebarTabProjectLookup {
  return new Map(
    projects.map((project) => {
      const identity = project.repositoryIdentity ?? null;
      return [
        `${project.environmentId}:${project.id}`,
        identity === null
          ? { repository: null, repositoryLabel: null, owner: null }
          : {
              repository: repositoryGroupingKeyOf(identity),
              repositoryLabel: repositoryGroupingDisplayNameOf(identity) ?? null,
              owner: repositoryOwnerOf(identity, "grouping"),
            },
      ] as const;
    }),
  );
}

export const sidebarTabThreadKey = (thread: Pick<SidebarTabThread, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;

const projectFactsOf = (thread: SidebarTabThread, projects: SidebarTabProjectLookup) =>
  projects.get(`${thread.environmentId}:${thread.projectId}`);

/** The rules this version knows. A rule from a newer version is skipped. */
const knownSidebarTabRules = (tab: Pick<SidebarTab, "rules">) =>
  tab.rules.filter(isKnownSidebarTabRule);

const isSidebarTabView = (tab: Pick<SidebarTab, "rules">) =>
  knownSidebarTabRules(tab).some((rule) => rule.field === "tab");

interface CompiledSidebarTab {
  readonly id: string;
  readonly rules: readonly SidebarTabRule[];
  readonly isView: boolean;
  /** It has a known rule and is not a view, so its rules claim threads. */
  readonly takesThreadsByRules: boolean;
}

/**
 * The tabs with their known rules and view flags, checked once per change of the tabs. The
 * per-thread loops read this, so the rule guard does not run for every thread.
 */
interface CompiledSidebarTabs {
  readonly assignments: SidebarTabs["assignments"];
  readonly defaultShowsAll: boolean;
  /** In tab order, which is the order rules claim threads in. */
  readonly tabs: readonly CompiledSidebarTab[];
  readonly byId: ReadonlyMap<string, CompiledSidebarTab>;
}

export function compileSidebarTabs(settings: SidebarTabs): CompiledSidebarTabs {
  const tabs = settings.tabs.map((tab): CompiledSidebarTab => {
    const rules = knownSidebarTabRules(tab);
    const isView = rules.some((rule) => rule.field === "tab");
    return { id: tab.id, rules, isView, takesThreadsByRules: rules.length > 0 && !isView };
  });
  return {
    assignments: settings.assignments,
    defaultShowsAll: defaultTabShowsAll(settings),
    tabs,
    byId: new Map(tabs.map((tab) => [tab.id, tab])),
  };
}

/** "Tab is not (no tab)": the rule of an "All" view. */
export const isAnyTabRule = (rule: SidebarTabRule) =>
  rule.field === "tab" && rule.operator === "is_not" && rule.values.length === 0;

/** The values that a thread has for a field. Null stands for "none". */
function threadValues(
  field: Exclude<SidebarTabRuleField, "title">,
  thread: SidebarTabThread,
  projects: SidebarTabProjectLookup,
  tabId: string,
): ReadonlyArray<string | null> {
  switch (field) {
    case "tab":
      return [tabId];
    case "project":
      return [projectFactsOf(thread, projects)?.repository ?? null];
    case "owner":
      return [projectFactsOf(thread, projects)?.owner ?? null];
    case "status":
      return [sidebarTabThreadStatus(thread)];
    case "provider":
      return [thread.providerInstanceId];
    case "createdBy":
      return [thread.source.createdBy];
    case "background": {
      const kinds = [...new Set((thread.pendingBackgroundTasks ?? []).map((task) => task.kind))];
      return kinds.length === 0 ? [null] : kinds;
    }
  }
}

function ruleMatches(
  rule: SidebarTabRule,
  thread: SidebarTabThread,
  projects: SidebarTabProjectLookup,
  tabId: string,
): boolean {
  const hit =
    rule.field === "title"
      ? rule.values.some(
          (value) => value !== null && thread.title.toLowerCase().includes(value.toLowerCase()),
        )
      : threadValues(rule.field, thread, projects, tabId).some((value) =>
          rule.values.includes(value),
        );
  return rule.operator === "is" ? hit : !hit;
}

const matchesEveryRule = (
  tab: CompiledSidebarTab,
  thread: SidebarTabThread,
  projects: SidebarTabProjectLookup,
  tabId: string,
) => tab.rules.every((rule) => ruleMatches(rule, thread, projects, tabId));

/** The tab that the rules alone give a thread: the first tab whose rules match it. */
function resolveRuleTabId(
  thread: SidebarTabThread,
  compiled: CompiledSidebarTabs,
  projects: SidebarTabProjectLookup,
): string {
  const tab = compiled.tabs.find(
    (candidate) =>
      candidate.takesThreadsByRules &&
      matchesEveryRule(candidate, thread, projects, DEFAULT_SIDEBAR_TAB_ID),
  );
  return tab?.id ?? DEFAULT_SIDEBAR_TAB_ID;
}

/** Whether a drag assignment can hold a thread: the default tab, or a tab that is not a view. */
const canHold = (compiled: CompiledSidebarTabs, tabId: string) =>
  tabId === DEFAULT_SIDEBAR_TAB_ID || compiled.byId.get(tabId)?.isView === false;

/** The tab that holds a thread. A drag assignment wins over the rules. */
export function resolveSidebarThreadTabId(
  thread: SidebarTabThread,
  compiled: CompiledSidebarTabs,
  projects: SidebarTabProjectLookup,
): string {
  const assigned = compiled.assignments[sidebarTabThreadKey(thread)];
  return assigned !== undefined && canHold(compiled, assigned)
    ? assigned
    : resolveRuleTabId(thread, compiled, projects);
}

/** Whether a tab shows a thread, given the tab that holds the thread. */
export function sidebarTabShowsThread(input: {
  readonly tabId: string;
  readonly thread: SidebarTabThread;
  readonly threadTabId: string;
  readonly compiled: CompiledSidebarTabs;
  readonly projects: SidebarTabProjectLookup;
}): boolean {
  if (input.tabId === DEFAULT_SIDEBAR_TAB_ID) {
    return input.compiled.defaultShowsAll || input.threadTabId === DEFAULT_SIDEBAR_TAB_ID;
  }
  const tab = input.compiled.byId.get(input.tabId);
  if (tab === undefined) return false;
  if (!tab.isView) return input.threadTabId === tab.id;
  return matchesEveryRule(tab, input.thread, input.projects, input.threadTabId);
}

/**
 * Assigns threads to a tab, by drag or by "Assign to tab". A thread that the tab already holds does not change. An
 * assignment is written only where the rules give another tab, so a drop on the default tab
 * writes nothing for a thread that no rule claims.
 */
export function moveSidebarThreads(
  settings: SidebarTabs,
  threads: ReadonlyArray<SidebarTabThread>,
  tabId: string,
  projects: SidebarTabProjectLookup,
): SidebarTabs {
  const compiled = compileSidebarTabs(settings);
  if (!canHold(compiled, tabId)) return settings;
  const assignments = { ...settings.assignments };
  for (const thread of threads) {
    if (resolveSidebarThreadTabId(thread, compiled, projects) === tabId) continue;
    const key = sidebarTabThreadKey(thread);
    if (resolveRuleTabId(thread, compiled, projects) === tabId) delete assignments[key];
    else assignments[key] = tabId;
  }
  return { ...settings, assignments };
}

/**
 * Drops assignments that can do nothing any more: a thread that is gone or archived on an
 * environment whose threads are loaded, or a tab that cannot hold threads. An entry that the
 * rules agree with stays: rules on status, background work or title change over time, and the
 * drag must still hold when they stop matching. An offline environment keeps its entries,
 * because its threads are not known.
 */
export function pruneSidebarTabAssignments(
  settings: SidebarTabs,
  liveThreads: ReadonlyArray<SidebarTabThread>,
): SidebarTabs {
  const compiled = compileSidebarTabs(settings);
  const liveKeys = new Set(liveThreads.map(sidebarTabThreadKey));
  const loadedEnvironments = new Set<string>(liveThreads.map((thread) => thread.environmentId));
  const assignments = Object.fromEntries(
    Object.entries(settings.assignments).filter(
      ([key, tabId]) =>
        canHold(compiled, tabId) &&
        (liveKeys.has(key) || !loadedEnvironments.has(key.slice(0, key.indexOf(":")))),
    ),
  );
  return { ...settings, assignments };
}

/** A new tab named "Tab N" with the lowest free N. */
export function createSidebarTab(settings: SidebarTabs, id: string): SidebarTabs {
  const names = new Set(settings.tabs.map((tab) => tab.name));
  let index = settings.tabs.length + 1;
  while (names.has(`Tab ${index}`)) index += 1;
  return { ...settings, tabs: [...settings.tabs, { id, name: `Tab ${index}`, rules: [] }] };
}

/** Deletes a tab. Its dragged threads go back to the rules, and views stop naming it. */
export function deleteSidebarTab(settings: SidebarTabs, tabId: string): SidebarTabs {
  const assignments = Object.fromEntries(
    Object.entries(settings.assignments).filter(([, assigned]) => assigned !== tabId),
  );
  const tabs = settings.tabs
    .filter((tab) => tab.id !== tabId)
    .map((tab) => ({
      ...tab,
      // The rule stays, also with no values, so a view does not turn into a tab that holds threads.
      rules: tab.rules.map((rule) =>
        rule.field === "tab"
          ? { ...rule, values: rule.values.filter((value) => value !== tabId) }
          : rule,
      ),
    }));
  return { ...settings, tabs, assignments };
}

export function updateSidebarTab(
  settings: SidebarTabs,
  tabId: string,
  update: (tab: SidebarTab) => SidebarTab,
): SidebarTabs {
  return {
    ...settings,
    tabs: settings.tabs.map((tab) => (tab.id === tabId ? update(tab) : tab)),
  };
}

export function updateSidebarDefaultTab(
  settings: SidebarTabs,
  update: (tab: SidebarTabs["defaultTab"]) => SidebarTabs["defaultTab"],
): SidebarTabs {
  return { ...settings, defaultTab: update(settings.defaultTab) };
}

/** Moves a tab to a new position, counted among the tabs (the default tab is fixed). */
export function moveSidebarTab(settings: SidebarTabs, tabId: string, toIndex: number): SidebarTabs {
  const tab = settings.tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined) return settings;
  const rest = settings.tabs.filter((candidate) => candidate.id !== tabId);
  const index = Math.max(0, Math.min(toIndex, rest.length));
  return { ...settings, tabs: [...rest.slice(0, index), tab, ...rest.slice(index)] };
}

/**
 * Checks or unchecks one value of a field in the rule editor. A field has one rule. Checking a
 * tab in an "any tab" view turns it into "tab is X". Unchecking the last value removes the
 * rule, so no rule is left with no values: "is not (nothing)" would match every thread. A view
 * keeps its tab rule as "any tab", so it does not turn into a tab that takes threads.
 */
export function toggleSidebarTabRuleValue(
  rules: SidebarTab["rules"],
  field: SidebarTabRuleField,
  value: string | null,
  checked: boolean,
): SidebarTab["rules"] {
  const index = rules.findIndex((rule) => isKnownSidebarTabRule(rule) && rule.field === field);
  const current = index === -1 ? null : rules[index]!;
  if (current === null || !isKnownSidebarTabRule(current)) {
    return checked ? [...rules, { field, operator: "is", values: [value] }] : rules;
  }
  const next: SidebarTabRule = checked
    ? isAnyTabRule(current)
      ? { field, operator: "is", values: [value] }
      : { ...current, values: [...current.values, value] }
    : { ...current, values: current.values.filter((candidate) => candidate !== value) };
  const kept: SidebarTabRule | null =
    next.values.length > 0
      ? next
      : field === "tab"
        ? { field, operator: "is_not", values: [] }
        : null;
  return kept === null
    ? rules.filter((_, candidate) => candidate !== index)
    : rules.map((rule, candidate) => (candidate === index ? kept : rule));
}

// Highest first. A tab shows the status of its most urgent thread.
const TAB_STATUS_PRIORITY: readonly SidebarTabStatusKind[] = [
  "approval",
  "input",
  "failed",
  "limited",
  "woke",
  "done",
  "working",
  "waiting",
];

/** The statuses that make a tab play its attention animation. */
export const SIDEBAR_TAB_ATTENTION_STATUSES: ReadonlySet<SidebarTabStatusKind> = new Set([
  "approval",
  "input",
  "failed",
  "limited",
]);

/** The tab status of one thread. It mirrors web `resolveSidebarV2TopStatus`. */
function sidebarTabTopStatus(state: {
  readonly status: SidebarTabThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}): SidebarTabStatusKind | null {
  if (state.status !== "ready") return state.status;
  if (state.isWoke) return "woke";
  return state.isUnread ? "done" : null;
}

/** The most urgent status of a tab, or null when every thread rests. */
export function resolveSidebarTabStatus(
  states: ReadonlyArray<{
    readonly thread: SidebarTabThread;
    readonly isUnread: boolean;
    readonly isWoke: boolean;
  }>,
): SidebarTabStatusKind | null {
  let best: SidebarTabStatusKind | null = null;
  for (const state of states) {
    const kind = sidebarTabTopStatus({
      status: sidebarTabThreadStatus(state.thread),
      isUnread: state.isUnread,
      isWoke: state.isWoke,
    });
    if (kind === null) continue;
    if (best === null || TAB_STATUS_PRIORITY.indexOf(kind) < TAB_STATUS_PRIORITY.indexOf(best)) {
      best = kind;
    }
  }
  return best;
}

const RULE_FIELD_LABELS: Record<SidebarTabRuleField, string> = {
  tab: "Tab",
  project: "Repository",
  owner: "Owner",
  status: "Status",
  provider: "Provider",
  createdBy: "Created by",
  background: "Background work",
  title: "Title",
};

/** Rule fields in menu order. */
export const SIDEBAR_TAB_RULE_FIELDS = SidebarTabRuleField.literals;

export const sidebarTabRuleFieldLabel = (field: SidebarTabRuleField) => RULE_FIELD_LABELS[field];

const STATUS_LABELS: Record<SidebarTabThreadStatus, string> = {
  approval: "Approval",
  input: "Input",
  working: "Working",
  waiting: "Waiting",
  failed: "Failed",
  limited: "Limited",
  ready: "Ready",
};

const CREATED_BY_LABELS: Record<SidebarTabThread["source"]["createdBy"], string> = {
  user: "You",
  agent: "An agent",
  system: "T3 Code",
};

type BackgroundKind = NonNullable<SidebarTabThread["pendingBackgroundTasks"]>[number]["kind"];
const BACKGROUND_LABELS: Record<BackgroundKind, string> = {
  monitor: "Monitor or pull request watch",
  subagent: "Subagent",
  command: "Command",
  background_task: "Background task",
};

export interface SidebarTabRuleOption {
  readonly value: string | null;
  readonly label: string;
}

/**
 * The values a rule of a field can pick. Repositories, owners and providers come from the
 * threads, so the menu lists only values that some thread has. A tab rule lists the other
 * tabs that hold threads.
 */
export function buildSidebarTabRuleOptions(input: {
  readonly field: Exclude<SidebarTabRuleField, "title">;
  readonly tabId: string;
  readonly threads: ReadonlyArray<SidebarTabThread>;
  readonly projects: SidebarTabProjectLookup;
  readonly settings: SidebarTabs;
}): SidebarTabRuleOption[] {
  const distinct = (values: ReadonlyArray<readonly [string | null, string]>, none: string) =>
    [...new Map(values)]
      .map(([value, label]) => ({ value, label: value === null ? none : label }))
      .sort((left, right) =>
        left.value === null ? 1 : right.value === null ? -1 : left.label.localeCompare(right.label),
      );
  const facts = (thread: SidebarTabThread) => projectFactsOf(thread, input.projects);
  switch (input.field) {
    case "tab":
      return [
        { value: DEFAULT_SIDEBAR_TAB_ID, label: sidebarDefaultTabName(input.settings) },
        ...input.settings.tabs
          .filter((tab) => tab.id !== input.tabId && !isSidebarTabView(tab))
          .map((tab) => ({ value: tab.id, label: tab.name })),
      ];
    case "project":
      return distinct(
        input.threads.map((thread) => {
          const repository = facts(thread)?.repository ?? null;
          return [repository, facts(thread)?.repositoryLabel ?? repository ?? ""] as const;
        }),
        "No repository",
      );
    case "owner":
      return distinct(
        input.threads.map((thread) => {
          const owner = facts(thread)?.owner ?? null;
          return [owner, owner ?? ""] as const;
        }),
        "No owner",
      );
    case "status":
      return Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }));
    case "provider":
      return distinct(
        input.threads.map((thread) => [thread.providerInstanceId, thread.providerInstanceId]),
        "None",
      );
    case "createdBy":
      return Object.entries(CREATED_BY_LABELS).map(([value, label]) => ({ value, label }));
    case "background":
      return [
        ...Object.entries(BACKGROUND_LABELS).map(([value, label]) => ({ value, label })),
        { value: null, label: "None" },
      ];
  }
}

/**
 * The tabs that fit the bar, by index, in display order. Every tab that shows, shows whole; the
 * rest go to the "more" menu, which then takes `moreWidth`. The selected tab always shows: when
 * it would overflow, it takes the place of the last tabs that fit before it.
 */
export function fitSidebarTabItems(input: {
  readonly widths: readonly number[];
  readonly available: number;
  readonly gap: number;
  readonly moreWidth: number;
  readonly selectedIndex: number;
}): number[] {
  const { widths, gap, selectedIndex } = input;
  const all = widths.map((_, index) => index);
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
  if (total <= input.available) return all;
  const budget = input.available - input.moreWidth - gap;
  const visible: number[] = [];
  let used = 0;
  for (const index of all) {
    const next = used + (visible.length === 0 ? 0 : gap) + widths[index]!;
    if (next > budget) break;
    visible.push(index);
    used = next;
  }
  if (selectedIndex < 0 || selectedIndex >= widths.length || visible.includes(selectedIndex)) {
    return visible;
  }
  const selectedWidth = widths[selectedIndex]!;
  while (visible.length > 0 && used + gap + selectedWidth > budget) {
    used -= widths[visible.pop()!]! + (visible.length === 0 ? 0 : gap);
  }
  return [...visible, selectedIndex];
}
