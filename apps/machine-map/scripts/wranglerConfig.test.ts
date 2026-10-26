import { expect, it } from "vite-plus/test";

import { isSet, readRouteHost, readVars, writeRoute, writeVar } from "./wranglerConfig.ts";

const CONFIG = `{
  "name": "t3-machine-map",
  "routes": [{ "pattern": "t3.example.com", "custom_domain": true }],
  "vars": {
    // The account.
    "ACCOUNT_ID": "account",
    "TEAM_DOMAIN": "REPLACE_ME",
  },
}`;

it("reads the values and the route host, and treats REPLACE_ values as not set", () => {
  const vars = readVars(CONFIG);
  expect(vars.get("ACCOUNT_ID")).toBe("account");
  expect(isSet(vars.get("ACCOUNT_ID"))).toBe(true);
  expect(isSet(vars.get("TEAM_DOMAIN"))).toBe(false);
  expect(readRouteHost(CONFIG)).toBe("t3.example.com");
});

it("changes only the value lines and keeps the comments", () => {
  const next = writeRoute(writeVar(CONFIG, "TEAM_DOMAIN", "team.example.com"), "t3.other.org");
  expect(readVars(next).get("TEAM_DOMAIN")).toBe("team.example.com");
  expect(readRouteHost(next)).toBe("t3.other.org");
  expect(next).toContain("// The account.");
  expect(next.split("\n")).toHaveLength(CONFIG.split("\n").length);
});

it("refuses a route that it cannot rewrite on one line", () => {
  expect(() => writeRoute(CONFIG.replace('"pattern": ', '"zone": '), "x")).toThrow();
});
