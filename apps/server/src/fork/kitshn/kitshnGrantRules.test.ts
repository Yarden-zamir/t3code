import { MACHINE_LEVEL_SCOPES } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  type AccessVisitor,
  type GrantState,
  appLevelScopes,
  kitshnPaused,
  levelFor,
  nextChangeAt,
  SAVED_GRANTS_LIFETIME,
  sessionAllowed,
} from "./kitshnGrantRules.ts";
import { GrantTables } from "./kitshnProviderProtocol.ts";

const NOW = 1_000_000;
const decodeTables = Schema.decodeUnknownSync(GrantTables);

const grant = (
  rules: ReadonlyArray<unknown>,
  level: string,
  options: { readonly match?: "any" | "all"; readonly endsAt?: number | null } = {},
) => ({
  circle: { id: "c", name: "Circle", match: options.match ?? "any", needsPasskey: true, rules },
  level,
  endsAt: options.endsAt ?? null,
});

const stateOf = (app: ReadonlyArray<unknown>, lastContactAt: number | null = NOW): GrantState => ({
  tables: decodeTables({ app }),
  lastContactAt,
});

const visitor = (fields: Partial<AccessVisitor>): AccessVisitor => ({
  email: null,
  clientId: null,
  ip: null,
  ...fields,
});

const appLevel = (state: GrantState, who: AccessVisitor, nowMs = NOW) =>
  levelFor(state, "t3.app", "app", who, nowMs);

describe("levelFor", () => {
  it.each([
    [
      "email, lowercase on both sides",
      { email: "Sam@Example.com" },
      visitor({ email: "sam@example.com" }),
      "standard",
    ],
    [
      "email of someone else",
      { email: "sam@example.com" },
      visitor({ email: "kim@example.com" }),
      null,
    ],
    [
      "domain, lowercase",
      { domain: "Example.COM" },
      visitor({ email: "kim@example.com" }),
      "standard",
    ],
    [
      "domain is not a suffix match",
      { domain: "example.com" },
      visitor({ email: "kim@badexample.com" }),
      null,
    ],
    ["ip in range", { ip: "203.0.113.0/24" }, visitor({ ip: "203.0.113.9" }), "standard"],
    ["ip out of range", { ip: "203.0.113.0/24" }, visitor({ ip: "198.51.100.9" }), null],
    ["ip of another family", { ip: "203.0.113.0/24" }, visitor({ ip: "2001:db8::1" }), null],
    [
      "device client id",
      { device: { clientId: "dev.access", name: "Phone" } },
      visitor({ clientId: "dev.access" }),
      "standard",
    ],
    [
      "machine client id",
      { machine: { machineId: "m-2", clientId: "m2.access" } },
      visitor({ clientId: "m2.access" }),
      "standard",
    ],
    [
      "machine of another token",
      { machine: { machineId: "m-2", clientId: "m2.access" } },
      visitor({ clientId: "m3.access" }),
      null,
    ],
    ["everyone", { everyone: true }, visitor({}), "standard"],
    ["unknown rule type", { passkeyGroup: "admins" }, visitor({ email: "sam@example.com" }), null],
  ] as const)("%s", (_name, rule, who, expected) => {
    expect(appLevel(stateOf([grant([rule], "standard")]), who)).toBe(expected);
  });

  it("matches an any circle on one rule and an all circle only on every rule", () => {
    const rules = [{ email: "sam@example.com" }, { ip: "10.0.0.0/8" }];
    const sam = visitor({ email: "sam@example.com", ip: "192.0.2.1" });
    expect(appLevel(stateOf([grant(rules, "read", { match: "any" })]), sam)).toBe("read");
    expect(appLevel(stateOf([grant(rules, "read", { match: "all" })]), sam)).toBeNull();
    expect(
      appLevel(stateOf([grant(rules, "read", { match: "all" })]), { ...sam, ip: "10.1.2.3" }),
    ).toBe("read");
  });

  it("fails an all circle on an unknown rule, and keeps the other grants of the table", () => {
    const sam = visitor({ email: "sam@example.com" });
    const state = stateOf([
      grant([{ email: "sam@example.com" }, { passkeyGroup: "admins" }], "admin", { match: "all" }),
      grant([{ email: "sam@example.com" }], "read"),
    ]);
    expect(appLevel(state, sam)).toBe("read");
  });

  it("gives the highest level of the matching grants, and nothing for an empty circle", () => {
    const sam = visitor({ email: "sam@example.com" });
    const state = stateOf([
      grant([{ everyone: true }], "read"),
      grant([{ domain: "example.com" }], "admin"),
      grant([{ email: "sam@example.com" }], "standard"),
      grant([], "admin"),
    ]);
    expect(appLevel(state, sam)).toBe("admin");
    expect(appLevel(stateOf([grant([], "admin")]), sam)).toBeNull();
  });

  it("refuses without a grant, after endsAt, for a level the kind does not have, and for a stale table", () => {
    const anyone = visitor({});
    expect(appLevel(stateOf([]), anyone)).toBeNull();
    expect(
      appLevel(stateOf([grant([{ everyone: true }], "read", { endsAt: NOW })]), anyone),
    ).toBeNull();
    expect(appLevel(stateOf([grant([{ everyone: true }], "exec")]), anyone)).toBeNull();
    const everyone = [grant([{ everyone: true }], "read")];
    expect(appLevel(stateOf(everyone, null), anyone)).toBeNull();
    const lifetime = Duration.toMillis(SAVED_GRANTS_LIFETIME);
    expect(appLevel(stateOf(everyone, NOW - lifetime + 1), anyone)).toBe("read");
    expect(appLevel(stateOf(everyone, NOW - lifetime), anyone)).toBeNull();
  });
});

describe("sessionAllowed", () => {
  const sam = visitor({ email: "sam@example.com" });

  it("allows a session within the level and refuses one above it", () => {
    const state = stateOf([grant([{ everyone: true }], "standard")]);
    expect(sessionAllowed(state, { scopes: appLevelScopes("read") }, sam, NOW)).toBe(true);
    expect(sessionAllowed(state, { scopes: appLevelScopes("standard") }, sam, NOW)).toBe(true);
    expect(sessionAllowed(state, { scopes: MACHINE_LEVEL_SCOPES.admin }, sam, NOW)).toBe(false);
    expect(sessionAllowed(stateOf([]), { scopes: [] }, sam, NOW)).toBe(false);
  });
});

describe("nextChangeAt", () => {
  it("is the earliest future endsAt, else the end of the saved table", () => {
    const lifetime = Duration.toMillis(SAVED_GRANTS_LIFETIME);
    expect(nextChangeAt(stateOf([]), NOW)).toBe(NOW + lifetime);
    expect(
      nextChangeAt(
        stateOf([
          grant([{ everyone: true }], "read", { endsAt: NOW - 1 }),
          grant([{ everyone: true }], "read", { endsAt: NOW + 50 }),
          grant([{ everyone: true }], "read", { endsAt: NOW + 10 }),
        ]),
        NOW,
      ),
    ).toBe(NOW + 10);
    expect(nextChangeAt(stateOf([], null), NOW)).toBeNull();
  });
});

describe("kitshnPaused", () => {
  it("reads a T3 card without any grant after kitshn answered as the emergency pause", () => {
    expect(kitshnPaused(stateOf([grant([], "admin")]))).toBe(false);
    expect(kitshnPaused(stateOf([]))).toBe(true);
    expect(kitshnPaused({ tables: {}, lastContactAt: NOW })).toBe(true);
    // Before kitshn answered, nothing is enforced, so nothing is paused.
    expect(kitshnPaused(stateOf([], null))).toBe(false);
  });
});
