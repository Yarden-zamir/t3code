import * as Schema from "effect/Schema";

/**
 * Fork: the back and forward history of the app. The browser history is the only history: the
 * title bar buttons, the keys, the command palette and the browser buttons all move in it. The
 * Navigation API gives the enabled state, the entries that the desktop app keeps after a
 * restart, and the direction of a back or forward move.
 */

const STORAGE_KEY = "t3code:fork:navigation-history:v1";
/** Set once per window. sessionStorage survives a reload but not a restart of the desktop app. */
const RESTORED_KEY = "t3code:fork:navigation-history-restored";

/**
 * Limit: the desktop app keeps only the last 50 entries up to the current one. Revisit if users
 * ask to go back further after a restart.
 */
export const NAVIGATION_HISTORY_LIMIT = 50;

const StoredNavigationHistory = Schema.Array(Schema.String);
const decodeStoredNavigationHistory = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredNavigationHistory),
);

/** A hash history href of the app, such as `#/env/thread`. */
const isAppHref = (href: string) => href.startsWith("#/");

/**
 * The entries to keep: the back history and the current entry, at most the limit. Forward
 * entries are not kept, because the start of the app is a new navigation that clears them.
 */
export function keptNavigationEntries(
  hrefs: ReadonlyArray<string>,
  currentIndex: number,
): ReadonlyArray<string> {
  const upToCurrent = hrefs.slice(0, currentIndex + 1).filter(isAppHref);
  return upToCurrent.slice(-NAVIGATION_HISTORY_LIMIT);
}

/**
 * TanStack Router keeps the position of an entry in its history state. The restored entries
 * need it, or the router counts each of them as the first entry. Revisit if
 * `@tanstack/history` renames `__TSR_index` or `__TSR_key`.
 */
function routerEntryState(index: number) {
  const key = Math.random().toString(36).slice(2, 10);
  return { __TSR_index: index, key, __TSR_key: key };
}

/** The parts of `window` that the restore uses. */
export interface NavigationRestoreTarget {
  readonly history: Pick<History, "pushState" | "replaceState">;
  readonly location: Pick<Location, "pathname" | "search" | "hash">;
  readonly localStorage: Storage;
  readonly sessionStorage: Storage;
}

/**
 * Desktop: puts the kept entries of the last run before the start entry, so back goes to the
 * views of the last run. Runs before the router starts, once per window: a reload keeps the
 * history of the window anyway.
 */
export function restoreNavigationHistory(win: NavigationRestoreTarget = window): void {
  try {
    restoreEntries(win);
  } catch (error) {
    // The app must start also when storage fails; it then starts without the old history.
    console.error("Could not restore the back and forward history.", error);
  }
}

function restoreEntries(win: NavigationRestoreTarget): void {
  if (win.sessionStorage.getItem(RESTORED_KEY) !== null) return;
  win.sessionStorage.setItem(RESTORED_KEY, "1");
  const stored = win.localStorage.getItem(STORAGE_KEY);
  if (stored === null) return;
  const decoded = decodeStoredNavigationHistory(stored);
  if (decoded._tag === "None") {
    win.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  const hrefs = decoded.value.filter(isAppHref).slice(-NAVIGATION_HISTORY_LIMIT);
  const [first, ...rest] = hrefs;
  if (first === undefined) return;
  const { pathname, search } = win.location;
  const startHref = `${pathname}${search}${win.location.hash}`;
  win.history.replaceState(routerEntryState(0), "", `${pathname}${search}${first}`);
  rest.forEach((href, index) => {
    win.history.pushState(routerEntryState(index + 1), "", `${pathname}${search}${href}`);
  });
  win.history.pushState(routerEntryState(hrefs.length), "", startHref);
}

/** Desktop: stores the kept entries of this window, for the next start. */
export function saveNavigationHistory(
  storage: Storage,
  urls: ReadonlyArray<string | null>,
  currentIndex: number,
): void {
  const hrefs = urls.map((url) => (url === null ? "" : new URL(url).hash));
  storage.setItem(STORAGE_KEY, JSON.stringify(keptNavigationEntries(hrefs, currentIndex)));
}

export function forgetNavigationHistory(storage: Storage): void {
  storage.removeItem(STORAGE_KEY);
}

/** The last back or forward move: the entry it went to, and its direction. */
export interface NavigationTraverse {
  readonly key: string;
  readonly direction: -1 | 1;
}

/**
 * The direction to keep going when the current entry is a thread or a draft that no longer
 * exists: the direction of the move that reached it, while there is an entry that way. Null
 * means no skip: the entry was not reached by back or forward, or nothing is left that way.
 */
export function skipDirection(input: {
  readonly traverse: NavigationTraverse | null;
  readonly currentKey: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}): -1 | 1 | null {
  const { traverse } = input;
  if (traverse === null || traverse.key !== input.currentKey) return null;
  const canContinue = traverse.direction === -1 ? input.canGoBack : input.canGoForward;
  return canContinue ? traverse.direction : null;
}

let lastTraverse: NavigationTraverse | null = null;
/** The entry that a skip started from, so that a second call during the move does nothing. */
let skippingFromKey: string | null = null;

/** Records each back and forward move, while `rememberBackForwardHistory` is on. */
export function trackNavigationTraverses(navigation: Navigation): () => void {
  const onNavigate = (event: NavigateEvent) => {
    const from = navigation.currentEntry?.index ?? -1;
    lastTraverse =
      event.navigationType === "traverse"
        ? { key: event.destination.key, direction: event.destination.index < from ? -1 : 1 }
        : null;
  };
  navigation.addEventListener("navigate", onNavigate);
  return () => {
    navigation.removeEventListener("navigate", onNavigate);
    lastTraverse = null;
  };
}

/**
 * Fork hook for the thread route: a missing thread or draft that back or forward reached is
 * skipped in the same direction. Otherwise `fallback` runs, the upstream redirect.
 */
export function leaveMissingRoute(fallback: () => void): void {
  const navigation = windowNavigation();
  const currentKey = navigation?.currentEntry?.key ?? null;
  if (currentKey !== null && currentKey === skippingFromKey) return;
  const direction =
    navigation === undefined
      ? null
      : skipDirection({
          traverse: lastTraverse,
          currentKey,
          canGoBack: navigation.canGoBack,
          canGoForward: navigation.canGoForward,
        });
  if (direction === null) {
    fallback();
    return;
  }
  skippingFromKey = currentKey;
  window.history.go(direction);
}

/**
 * Whether back and forward have an entry to go to. Without the Navigation API (older Safari
 * and Firefox), both stay enabled, and a move with nothing to go to does nothing.
 */
export function navigationAvailability(navigation: Navigation | undefined): {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
} {
  if (navigation === undefined) return { canGoBack: true, canGoForward: true };
  return { canGoBack: navigation.canGoBack, canGoForward: navigation.canGoForward };
}

/** The Navigation API of this window, or undefined where the browser has none. */
export function windowNavigation(): Navigation | undefined {
  return typeof window !== "undefined" && "navigation" in window ? window.navigation : undefined;
}
