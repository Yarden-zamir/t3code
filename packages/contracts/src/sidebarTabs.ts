/**
 * Fork: sidebar tabs, the value of the `sidebarTabs` server setting.
 *
 * Every machine holds this value, and a newer T3 version can write a rule that an older one does
 * not know. So a stored rule decodes with open strings, and clients skip a rule that is not a
 * `SidebarTabRule`. A closed schema here would make an older server reject the whole settings
 * patch, or reset every setting when it reads a newer `settings.json`.
 *
 * @module sidebarTabs
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  type ForkKeybindingCommand,
  SIDEBAR_TAB_JUMP_KEYBINDING_COMMANDS,
} from "./forkKeybindings.ts";

/** What a rule compares. `tab` compares the tab that holds the thread. */
export const SidebarTabRuleField = Schema.Literals([
  "tab",
  "project",
  "owner",
  "status",
  "provider",
  "createdBy",
  "background",
  "title",
]);
export type SidebarTabRuleField = typeof SidebarTabRuleField.Type;

/**
 * A rule this version knows. "is" matches a thread that has one of `values`, and "is_not" matches
 * a thread that has none of them. A `title` value matches when the title contains it. Null stands
 * for "none", for example a project without a repository.
 */
export const SidebarTabRule = Schema.Struct({
  field: SidebarTabRuleField,
  operator: Schema.Literals(["is", "is_not"]),
  values: Schema.Array(Schema.NullOr(Schema.String)),
});
export type SidebarTabRule = typeof SidebarTabRule.Type;

/** A rule as stored. It can come from a newer version; see `isKnownSidebarTabRule`. */
const SidebarTabStoredRule = Schema.Struct({
  field: Schema.String,
  operator: Schema.String,
  values: Schema.Array(Schema.NullOr(Schema.String)),
});
export type SidebarTabStoredRule = typeof SidebarTabStoredRule.Type;

export const isKnownSidebarTabRule = Schema.is(SidebarTabRule);

/**
 * How a tab looks. `icon` is an id of the tab icon set, or `none`; without it the tab shows a
 * dot. An id from a newer version decodes as a string, and the tab then shows the dot.
 * `showName: false` hides the name on the tab; its tooltip keeps it.
 */
const SidebarTabLook = {
  icon: Schema.optional(Schema.String),
  showName: Schema.optional(Schema.Boolean),
};

/** A tab. A thread matches the tab when it matches every known rule. */
export const SidebarTab = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  rules: Schema.Array(SidebarTabStoredRule).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  ...SidebarTabLook,
});
export type SidebarTab = typeof SidebarTab.Type;

export const SidebarTabs = Schema.Struct({
  /** Tabs in tab order. The default tab is not in this list. */
  tabs: Schema.Array(SidebarTab).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * Thread key (`environmentId:threadId`) to the tab that the user assigned the thread to.
   * The id `default` keeps a thread in the default tab when a tab rule matches it. Clients
   * drop an entry when its thread is gone or archived, or when its tab cannot hold threads.
   */
  assignments: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /**
   * The first tab. `show` is `untabbed` (the threads in no other tab, the default) or `all`
   * (every thread). An unknown value from a newer version reads as `untabbed`.
   */
  defaultTab: Schema.Struct({
    name: Schema.optional(TrimmedNonEmptyString),
    show: Schema.optional(Schema.String),
    ...SidebarTabLook,
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type SidebarTabs = typeof SidebarTabs.Type;

/** The stored keys from before tabs were called groups, and their new names, by settings scope. */
const LEGACY_SIDEBAR_TAB_KEYS = {
  server: { sidebarGroups: "sidebarTabs", mobileSidebarGroups: "mobileSidebarTabs" },
  client: {
    sidebarGroupsEnabled: "sidebarTabsEnabled",
    sidebarGroupSingleThreadOpens: "sidebarTabSingleThreadOpens",
  },
} as const satisfies Record<"server" | "client", Record<string, string>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A stored `sidebarGroups` value in the shape of `SidebarTabs`: `groups` becomes `tabs`, a rule on
 * `group` becomes a rule on `tab`, and `show: "ungrouped"` becomes `untabbed`. A value that is not
 * an object stays, so its decode fails as before.
 */
function sidebarTabsFromLegacy(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { groups, ...rest } = value;
  const tabs = Array.isArray(groups)
    ? groups.map((tab: unknown) =>
        isRecord(tab) && Array.isArray(tab.rules)
          ? {
              ...tab,
              rules: tab.rules.map((rule: unknown) =>
                isRecord(rule) && rule.field === "group" ? { ...rule, field: "tab" } : rule,
              ),
            }
          : tab,
      )
    : groups;
  const defaultTab =
    isRecord(rest.defaultTab) && rest.defaultTab.show === "ungrouped"
      ? { ...rest.defaultTab, show: "untabbed" }
      : rest.defaultTab;
  return {
    ...rest,
    ...(tabs === undefined ? {} : { tabs }),
    ...(defaultTab === undefined ? {} : { defaultTab }),
  };
}

/**
 * Moves each stored key from before the rename to its new name, once. A value under the new key
 * wins, and the old key goes either way. Null when no old key is present, so a caller writes only
 * after a move.
 */
export function moveLegacySidebarTabKeys(
  scope: "server" | "client",
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  const renames = Object.entries(LEGACY_SIDEBAR_TAB_KEYS[scope]);
  if (!renames.some(([from]) => Object.hasOwn(values, from))) return null;
  const moved: Record<string, unknown> = { ...values };
  for (const [from, to] of renames) {
    if (!Object.hasOwn(moved, from)) continue;
    if (!Object.hasOwn(moved, to)) {
      moved[to] = from === "sidebarGroups" ? sidebarTabsFromLegacy(moved[from]) : moved[from];
    }
    delete moved[from];
  }
  return moved;
}

/** The sidebar tab commands from before tabs were called groups, and their new names. */
const LEGACY_SIDEBAR_TAB_COMMANDS: ReadonlyMap<string, ForkKeybindingCommand> = new Map([
  ["sidebar.previousGroup", "sidebar.previousTab"],
  ["sidebar.nextGroup", "sidebar.nextTab"],
  ...SIDEBAR_TAB_JUMP_KEYBINDING_COMMANDS.map(
    (command, index) => [`sidebar.group.${index + 1}`, command] as const,
  ),
]);

/**
 * Raw keybinding entries with each old sidebar tab command renamed, or null when no entry has
 * one. `keybindings.json` and the shared `keybindings` setting of the machine map hold them.
 */
export function renameLegacySidebarTabCommands(
  entries: ReadonlyArray<unknown>,
): Array<unknown> | null {
  let renamed = false;
  const next = entries.map((entry) => {
    if (typeof entry !== "object" || entry === null || !("command" in entry)) return entry;
    const command = typeof entry.command === "string" ? entry.command : undefined;
    const to = command === undefined ? undefined : LEGACY_SIDEBAR_TAB_COMMANDS.get(command);
    if (to === undefined) return entry;
    renamed = true;
    return { ...entry, command: to };
  });
  return renamed ? next : null;
}
