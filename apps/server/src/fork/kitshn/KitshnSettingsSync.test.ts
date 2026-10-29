import { expect, it } from "@effect/vitest";

import { effectiveSettings } from "./KitshnSettingsSync.ts";

it("applies the shared part, then this machine's part over it", () => {
  expect(
    effectiveSettings({
      shared: { server: { a: 1, b: 1 }, client: { theme: "dark" } },
      machine: { server: { b: 2 }, client: {} },
    }),
  ).toEqual({ server: { a: 1, b: 2 }, client: { theme: "dark" } });
  // A part that is not set, or not in the `{ server, client }` shape, counts as empty.
  expect(effectiveSettings({ shared: null, machine: "broken" })).toEqual({
    server: {},
    client: {},
  });
  expect(effectiveSettings(null)).toEqual({ server: {}, client: {} });
});
