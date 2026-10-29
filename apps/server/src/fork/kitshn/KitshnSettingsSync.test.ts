import { expect, it } from "@effect/vitest";

import { effectiveSettings, sharedPartAfterShare } from "./KitshnSettingsSync.ts";

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

it("shares the saved server values and the client values over the shared part", () => {
  expect(
    sharedPartAfterShare(
      { server: { a: 1, keep: true }, client: { chatWidth: "wide" } },
      { a: 2, notSaved: undefined, unasked: 3 },
      { server: ["a", "missing"], client: { chatWidth: "full" } },
    ),
  ).toEqual({ server: { a: 2, keep: true }, client: { chatWidth: "full" } });
});
