import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ApproveClientRequest, ChangesRequest, InviteRequest } from "./api.ts";

const decodeInvite = Schema.decodeUnknownSync(InviteRequest);

it("keeps the saved-state precondition on each approval-path request", () => {
  const client = { _tag: "new", name: "Phone" };
  expect(decodeInvite({ client, arrows: [], expectedState: "before" }).expectedState).toBe(
    "before",
  );
  expect(
    Schema.decodeUnknownSync(ApproveClientRequest)({
      thumbprint: "key",
      client,
      arrows: [],
      expectedState: "before",
    }).expectedState,
  ).toBe("before");
  expect(
    Schema.decodeSync(ChangesRequest)({
      summary: "Enforce",
      changes: [
        {
          _tag: "setSetting",
          machineId: "mac",
          scope: "server",
          key: "clientAccess",
          present: true,
          value: "enforce",
        },
      ],
      expectedState: "before",
    }).expectedState,
  ).toBe("before");
});

it("keeps the chosen map point and arrows on a new app invite", () => {
  const request = {
    client: { _tag: "new", name: "Phone", position: { x: -240, y: 1800 } },
    arrows: [
      { to: "mac", level: "standard" },
      { to: "vps", level: "read" },
    ],
  };
  expect(decodeInvite(request)).toEqual(request);
});

it("still accepts new app invites without a map point and existing-client invites", () => {
  expect(decodeInvite({ client: { _tag: "new", name: "Pixel" }, arrows: [] }).client).toEqual({
    _tag: "new",
    name: "Pixel",
  });
  expect(
    decodeInvite({ client: { _tag: "existing", clientId: "phone" }, arrows: [] }).client,
  ).toEqual({ _tag: "existing", clientId: "phone" });
});

it.each([NaN, Infinity, -Infinity, "240"])("refuses an invalid map coordinate %s", (x) => {
  expect(() =>
    decodeInvite({
      client: { _tag: "new", name: "Phone", position: { x, y: 120 } },
      arrows: [],
    }),
  ).toThrow();
});
