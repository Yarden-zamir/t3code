import { MACHINE_LEVEL_SCOPES } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { appLevelScopes, levelFor, sessionAllowed } from "./kitshnGrantRules.ts";

describe("levelFor", () => {
  it("reads the level of a resource, and none for a level that the kind does not have", () => {
    expect(levelFor("t3.app", "app", { app: "standard" })).toBe("standard");
    expect(levelFor("t3.thread", "th-1", { "th-1": "send" })).toBe("send");
    expect(levelFor("t3.app", "app", { "th-1": "send" })).toBeNull();
    // A level name of another kind, or a future one, grants nothing.
    expect(levelFor("t3.app", "app", { app: "send" })).toBeNull();
  });
});

describe("sessionAllowed", () => {
  it("allows a session within the app level and refuses one above it", () => {
    const standard = { app: "standard" };
    expect(sessionAllowed({ scopes: appLevelScopes("read") }, standard)).toBe(true);
    expect(sessionAllowed({ scopes: appLevelScopes("standard") }, standard)).toBe(true);
    expect(sessionAllowed({ scopes: MACHINE_LEVEL_SCOPES.admin }, standard)).toBe(false);
    expect(sessionAllowed({ scopes: [] }, {})).toBe(false);
  });
});
