import * as Schema from "effect/Schema";
import { useEffect } from "react";

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

/** Where the window stands in its history, as the Navigation API reports it. */
export interface NavigationPosition {
  readonly key: string | null;
  readonly index: number;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/**
 * Skips a thread or a draft that no longer exists when back or forward reaches it: the move
 * goes on in the same direction while there is an entry that way. Only on arrival: an entry
 * that showed its view and lost it later keeps the upstream redirect.
 */
export function createMissingEntrySkipper(
  read: () => NavigationPosition,
  go: (direction: -1 | 1) => void,
) {
  /** The entry that the last back or forward move reached, while its view has not shown. */
  let arrival: { readonly key: string; readonly direction: -1 | 1 } | null = null;
  /** The entry that a skip left, so that a second call before the move starts does nothing. */
  let skippingFromKey: string | null = null;
  return {
    onNavigate(navigationType: NavigationType, destination: { key: string; index: number }) {
      skippingFromKey = null;
      arrival =
        navigationType === "traverse"
          ? { key: destination.key, direction: destination.index < read().index ? -1 : 1 }
          : null;
    },
    /** The view of the current entry showed, so a later loss of it is not a skip. */
    settle() {
      arrival = null;
    },
    reset() {
      arrival = null;
      skippingFromKey = null;
    },
    leave(fallback: () => void) {
      const position = read();
      if (position.key !== null && position.key === skippingFromKey) return;
      const direction = arrival !== null && arrival.key === position.key ? arrival.direction : null;
      const canContinue =
        direction === -1 ? position.canGoBack : direction === 1 && position.canGoForward;
      if (direction === null || !canContinue) {
        fallback();
        return;
      }
      skippingFromKey = position.key;
      go(direction);
    },
  };
}

function readWindowPosition(): NavigationPosition {
  const navigation = windowNavigation();
  const current = navigation?.currentEntry ?? null;
  return {
    key: current?.key ?? null,
    index: current?.index ?? -1,
    canGoBack: navigation?.canGoBack ?? false,
    canGoForward: navigation?.canGoForward ?? false,
  };
}

const windowSkipper = createMissingEntrySkipper(readWindowPosition, (direction) =>
  window.history.go(direction),
);

/** Records each back and forward move, while `rememberBackForwardHistory` is on. */
export function trackNavigationTraverses(navigation: Navigation): () => void {
  const onNavigate = (event: NavigateEvent) =>
    windowSkipper.onNavigate(event.navigationType, event.destination);
  navigation.addEventListener("navigate", onNavigate);
  return () => {
    navigation.removeEventListener("navigate", onNavigate);
    windowSkipper.reset();
  };
}

/** Fork hook for the thread route: skips a missing entry, or runs `fallback`, the upstream redirect. */
export function leaveMissingRoute(fallback: () => void): void {
  windowSkipper.leave(fallback);
}

/** Fork hook for the thread route: `shown` is true while the thread or draft shows its view. */
export function useSettleNavigationTraverse(shown: boolean): void {
  // No dependency list: a move between two shown threads keeps `shown` true, and each such
  // arrival must settle too. The call is a cheap assignment.
  useEffect(() => {
    if (shown) windowSkipper.settle();
  });
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
