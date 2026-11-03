import type { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { withLateConfigDiscovery } from "./ws.ts";

const config = (label: string) =>
  ({
    availableEditors: [],
    settings: {},
    environment: { label },
  }) as unknown as ServerConfig;

it.effect("a late remote target snapshot keeps a newer environment label", () =>
  Effect.gen(function* () {
    const labelSent = yield* Deferred.make<void>();
    const targets = [{ kind: "mdns" as const, host: "test.local" }];
    const labelSnapshot: ServerConfigStreamEvent = {
      version: 1,
      type: "snapshot",
      config: config("renamed"),
    };
    const events = yield* withLateConfigDiscovery(
      config("initial"),
      Stream.make(labelSnapshot),
      {
        resolveAvailableEditors: () => Effect.succeed([]),
        resolveFileManagerRevealKind: () => Effect.succeed("finder"),
      },
      { resolveTargets: () => Deferred.await(labelSent).pipe(Effect.as(targets)) },
      { resolve: () => Effect.succeed([]) },
    ).pipe(
      Stream.tap((event) =>
        event.type === "snapshot" ? Deferred.succeed(labelSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const last = Array.from(events).at(-1);
    assert.equal(last?.type, "snapshot");
    if (last?.type === "snapshot") {
      assert.deepEqual(last.config.remoteOpenTargets, targets);
      assert.equal(last.config.environment.label, "renamed");
    }
  }),
);
