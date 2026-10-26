import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { isSet, readRouteHost, readVars, writeRoute, writeVar } from "./wranglerConfig.ts";

const config = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "..", "wrangler.jsonc"),
  "utf8",
);

it("reads the values of the real wrangler.jsonc", () => {
  const vars = readVars(config);
  for (const key of [
    "ACCOUNT_ID",
    "TEAM_DOMAIN",
    "PAGE_AUD",
    "CONNECT_ACCESS_APP_ID",
    "MACHINE_ZONE_ID",
  ])
    expect(isSet(vars.get(key)), key).toBe(true);
  expect(readRouteHost(config)).toBe("t3.yarden-zamir.com");
  expect(isSet("REPLACE_ME")).toBe(false);
});

it("changes only the value lines and keeps the comments", () => {
  const next = writeRoute(writeVar(config, "PAGE_AUD", "new-aud"), "t3.example.com");
  expect(readVars(next).get("PAGE_AUD")).toBe("new-aud");
  expect(readRouteHost(next)).toBe("t3.example.com");
  expect(next.split("\n").filter((line) => line.trim().startsWith("//"))).toEqual(
    config.split("\n").filter((line) => line.trim().startsWith("//")),
  );
  expect(next.split("\n")).toHaveLength(config.split("\n").length);
});
