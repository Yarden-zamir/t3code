import { describe, expect, it } from "vite-plus/test";

import {
  NAVIGATION_HISTORY_LIMIT,
  createMissingEntrySkipper,
  keptNavigationEntries,
  navigationAvailability,
  restoreNavigationHistory,
  saveNavigationHistory,
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

/**
 * A window history of entry keys. `traverse` moves like back and forward do: the navigate
 * event first, then the current entry changes. A skip calls `traverse` again.
 */
function createHistoryStub(keys: ReadonlyArray<string>, startIndex: number) {
  let index = startIndex;
  const fallbacks: string[] = [];
  const skipper = createMissingEntrySkipper(
    () => ({
      key: keys[index] ?? null,
      index,
      canGoBack: index > 0,
      canGoForward: index < keys.length - 1,
    }),
    (direction) => traverse(direction),
  );
  function traverse(delta: number) {
    const next = index + delta;
    skipper.onNavigate("traverse", { key: keys[next] ?? "", index: next });
    index = next;
  }
  return {
    skipper,
    traverse,
    current: () => keys[index],
    /** The thread route of the current entry found its thread missing. */
    reportMissing: () => skipper.leave(() => fallbacks.push(keys[index] ?? "")),
    fallbacks,
  };
}

describe("createMissingEntrySkipper", () => {
  it("keeps going back past a missing entry that back reached", () => {
    const history = createHistoryStub(["a", "missing", "b"], 2);
    history.traverse(-1);
    history.reportMissing();
    expect(history.current()).toBe("a");
    expect(history.fallbacks).toEqual([]);
  });

  it("skips the same missing entry again on the way forward", () => {
    const history = createHistoryStub(["a", "missing", "b"], 2);
    history.traverse(-1);
    history.reportMissing();
    history.skipper.settle();
    history.traverse(1);
    history.reportMissing();
    expect(history.current()).toBe("b");
    expect(history.fallbacks).toEqual([]);
  });

  it("skips once when the route reports the missing entry twice before the move", () => {
    const keys = ["a", "missing", "b"];
    let index = 2;
    const moves: number[] = [];
    const skipper = createMissingEntrySkipper(
      () => ({ key: keys[index] ?? null, index, canGoBack: true, canGoForward: true }),
      (direction) => moves.push(direction),
    );
    skipper.onNavigate("traverse", { key: "missing", index: 1 });
    index = 1;
    skipper.leave(() => {});
    skipper.leave(() => {});
    expect(moves).toEqual([-1]);
  });

  it("runs the upstream redirect when nothing is left in that direction", () => {
    const history = createHistoryStub(["missing", "b"], 1);
    history.traverse(-1);
    history.reportMissing();
    expect(history.fallbacks).toEqual(["missing"]);
  });

  it("runs the upstream redirect for an entry that a link reached", () => {
    const history = createHistoryStub(["a", "missing"], 1);
    history.skipper.onNavigate("push", { key: "", index: -1 });
    history.reportMissing();
    expect(history.fallbacks).toEqual(["missing"]);
  });

  it("runs the upstream redirect for a thread that disappears after it showed", () => {
    const history = createHistoryStub(["a", "deleted-later", "b"], 2);
    history.traverse(-1);
    history.skipper.settle();
    history.reportMissing();
    expect(history.current()).toBe("deleted-later");
    expect(history.fallbacks).toEqual(["deleted-later"]);
  });
});

describe("navigationAvailability", () => {
  it("keeps both buttons enabled where the browser has no Navigation API", () => {
    expect(navigationAvailability(undefined)).toEqual({ canGoBack: true, canGoForward: true });
  });
});
