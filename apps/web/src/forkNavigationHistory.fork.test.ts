import { describe, expect, it } from "vite-plus/test";

import {
  NAVIGATION_HISTORY_LIMIT,
  keptNavigationEntries,
  navigationAvailability,
  restoreNavigationHistory,
  saveNavigationHistory,
  skipDirection,
  type NavigationRestoreTarget,
} from "./forkNavigationHistory";

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

/** A fresh desktop window: one entry, the start URL without a hash. */
function createWindowStub(localStorage: Storage) {
  const entries: Array<{ readonly url: string; readonly index: unknown }> = [
    { url: "/", index: undefined },
  ];
  const write = (state: unknown, url: string | URL | null | undefined) => ({
    url: String(url),
    index: (state as { __TSR_index?: unknown }).__TSR_index,
  });
  const target: NavigationRestoreTarget = {
    history: {
      replaceState: (state, _unused, url) => {
        entries[entries.length - 1] = write(state, url);
      },
      pushState: (state, _unused, url) => {
        entries.push(write(state, url));
      },
    },
    location: { pathname: "/", search: "", hash: "" },
    localStorage,
    sessionStorage: createStorageStub(),
  };
  return { target, entries };
}

const appUrl = (hash: string) => `t3://app/${hash}`;

describe("keptNavigationEntries", () => {
  it("keeps the back history and the current entry, not the forward entries", () => {
    expect(keptNavigationEntries(["#/a", "#/b", "#/c", "#/d"], 1)).toEqual(["#/a", "#/b"]);
  });

  it("keeps only the newest entries up to the limit", () => {
    const hrefs = Array.from({ length: NAVIGATION_HISTORY_LIMIT + 10 }, (_, i) => `#/t${i}`);
    const kept = keptNavigationEntries(hrefs, hrefs.length - 1);
    expect(kept).toHaveLength(NAVIGATION_HISTORY_LIMIT);
    expect(kept.at(0)).toBe("#/t10");
    expect(kept.at(-1)).toBe(hrefs.at(-1));
  });

  it("drops entries that are not app routes", () => {
    expect(keptNavigationEntries(["", "#/a"], 1)).toEqual(["#/a"]);
  });
});

describe("restoreNavigationHistory", () => {
  it("puts the saved entries before the start entry, with router positions", () => {
    const localStorage = createStorageStub();
    saveNavigationHistory(localStorage, [appUrl("#/a"), appUrl("#/b"), appUrl("#/forward")], 1);
    const { target, entries } = createWindowStub(localStorage);

    restoreNavigationHistory(target);

    expect(entries).toEqual([
      { url: "/#/a", index: 0 },
      { url: "/#/b", index: 1 },
      { url: "/", index: 2 },
    ]);
  });

  it("restores once per window, so a reload does not add the entries again", () => {
    const localStorage = createStorageStub();
    saveNavigationHistory(localStorage, [appUrl("#/a")], 0);
    const { target, entries } = createWindowStub(localStorage);

    restoreNavigationHistory(target);
    restoreNavigationHistory(target);

    expect(entries).toHaveLength(2);
  });

  it("starts without old history when the stored value is broken", () => {
    const localStorage = createStorageStub();
    localStorage.setItem("t3code:fork:navigation-history:v1", "{not json");
    const { target, entries } = createWindowStub(localStorage);

    restoreNavigationHistory(target);

    expect(entries).toEqual([{ url: "/", index: undefined }]);
    expect(localStorage.length).toBe(0);
  });

  it("does nothing without a saved history", () => {
    const { target, entries } = createWindowStub(createStorageStub());

    restoreNavigationHistory(target);

    expect(entries).toEqual([{ url: "/", index: undefined }]);
  });
});

describe("skipDirection", () => {
  const traverse = { key: "missing", direction: -1 } as const;

  it("keeps going back past a missing entry that back reached", () => {
    expect(
      skipDirection({ traverse, currentKey: "missing", canGoBack: true, canGoForward: true }),
    ).toBe(-1);
  });

  it("keeps going forward past a missing entry that forward reached", () => {
    expect(
      skipDirection({
        traverse: { key: "missing", direction: 1 },
        currentKey: "missing",
        canGoBack: true,
        canGoForward: true,
      }),
    ).toBe(1);
  });

  it("does not skip when nothing is left in that direction", () => {
    expect(
      skipDirection({ traverse, currentKey: "missing", canGoBack: false, canGoForward: true }),
    ).toBeNull();
  });

  it("does not skip an entry that a link or a new navigation reached", () => {
    expect(
      skipDirection({ traverse, currentKey: "other", canGoBack: true, canGoForward: true }),
    ).toBeNull();
    expect(
      skipDirection({ traverse: null, currentKey: "missing", canGoBack: true, canGoForward: true }),
    ).toBeNull();
  });
});

describe("navigationAvailability", () => {
  it("keeps both buttons enabled where the browser has no Navigation API", () => {
    expect(navigationAvailability(undefined)).toEqual({ canGoBack: true, canGoForward: true });
  });
});
