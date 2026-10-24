import { forkSettingsSearchItems } from "./forkSettingsCatalog";
import { SETTINGS_SEARCH_ITEMS, searchSettings, type SettingsSearchItem } from "./settingsSearch";

/**
 * Fork: the find box of one Settings page (`settings.find`). It uses the settings search, so a
 * row matches by its search title and keywords, and it hides the page elements by their search
 * anchors. Limit: a row without a search item, such as a row that a toggle reveals, hides while
 * the box has text. Revisit if users miss such rows; matching the row text would be a second
 * matcher.
 */

const ALL_ITEMS: ReadonlyArray<SettingsSearchItem> = [
  ...SETTINGS_SEARCH_ITEMS,
  ...forkSettingsSearchItems(SETTINGS_SEARCH_ITEMS),
];

const HIDDEN_ATTRIBUTE = "data-settings-find-hidden";

export interface SettingsFindMatch {
  /** The element ids of the search items of this page. */
  readonly pageAnchors: ReadonlySet<string>;
  /** The element ids of the items that match the query. */
  readonly matched: ReadonlySet<string>;
}

function anchorOf(item: SettingsSearchItem): string {
  return item.targetId ?? item.id;
}

/** The search anchors of the page at `pathname`, and those that match `query`. */
export function settingsFindMatch(
  query: string,
  pathname: string,
  items: ReadonlyArray<SettingsSearchItem> = ALL_ITEMS,
): SettingsFindMatch {
  const pageItems = items.filter((item) => item.to === pathname);
  return {
    pageAnchors: new Set(pageItems.map(anchorOf)),
    matched: new Set(searchSettings(query, pageItems, { matchPageLabel: false }).map(anchorOf)),
  };
}

// Pages that list records, not setting rows. There `mod+f` stays with the settings search.
const LIST_PAGES: ReadonlySet<string> = new Set([
  "/settings/archived",
  "/settings/scheduled-tasks",
  "/settings/open-source-licenses",
  "/settings/projects",
]);

/** Whether the find box can filter the page at `pathname`: a page of setting rows. */
export function isSettingsFindPage(pathname: string): boolean {
  return !LIST_PAGES.has(pathname) && settingsFindMatch("", pathname).pageAnchors.size > 0;
}

/** The matched elements on the page, in page order. */
export function matchedSettingsElements(
  root: ParentNode,
  match: SettingsFindMatch,
): ReadonlyArray<HTMLElement> {
  return Array.from(root.querySelectorAll<HTMLElement>("[id]")).filter((element) =>
    match.matched.has(element.id),
  );
}

/**
 * Hides each row, section and search anchor of the page that is not a match, does not hold one
 * and is not inside one. A section without a shown row hides with its header.
 */
export function applySettingsFind(root: HTMLElement, match: SettingsFindMatch): void {
  clearSettingsFind(root);
  const matched = matchedSettingsElements(root, match);
  const shown = (element: Element) =>
    matched.some((target) => target.contains(element) || element.contains(target));
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>('[data-slot="settings-row"], section, [id]'),
  ).filter(
    (element) =>
      element.matches('[data-slot="settings-row"], section') || match.pageAnchors.has(element.id),
  );
  for (const element of candidates) {
    if (!shown(element)) element.setAttribute(HIDDEN_ATTRIBUTE, "");
  }
}

export function clearSettingsFind(root: ParentNode): void {
  for (const element of root.querySelectorAll(`[${HIDDEN_ATTRIBUTE}]`)) {
    element.removeAttribute(HIDDEN_ATTRIBUTE);
  }
}
