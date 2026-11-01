import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { machineDaemons } from "./kitshnDaemon.ts";

it.effect("reads the daemon of each machine card, and null while it is offline", () =>
  Effect.gen(function* () {
    const daemons = yield* machineDaemons({
      rights: [],
      cards: [
        {
          id: "oracle-vps-08e635",
          kind: "machine",
          status: "online",
          daemon: { version: "a573a04848bd", protocol: "2.1.0", next: "x" },
        },
        { id: "windows-2-bcc6f2", kind: "machine", status: "offline", daemon: null },
        // An older kitshn sends no daemon key.
        { id: "old-machine", kind: "machine" },
        { id: "p-7431c6da5e2f345c", kind: "t3.app", addresses: ["t3-mac.example.com"] },
      ],
    });
    expect(Object.fromEntries(daemons)).toEqual({
      "oracle-vps-08e635": { version: "a573a04848bd", protocol: "2.1.0" },
      "windows-2-bcc6f2": null,
      "old-machine": null,
    });
  }),
);
