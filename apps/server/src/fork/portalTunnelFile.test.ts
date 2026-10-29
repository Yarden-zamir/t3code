import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { runWhileNotServed } from "./portalTunnelFile.ts";

const HOST = "t3-oracle-vps.example.com";

it.effect("runs the portal tunnel while kitshn does not serve its host (K-1623)", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<"start" | "stop">();
    const run = Queue.offer(events, "start").pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Queue.offer(events, "stop")),
    );
    // No `served` from an older kitshn reads as an empty list: the tunnel runs.
    const served = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
    yield* runWhileNotServed(SubscriptionRef.changes(served), HOST, run).pipe(Effect.forkChild);
    expect(yield* Queue.take(events)).toBe("start");
    // Another host changes nothing; then the record points at kitshn: stop.
    yield* SubscriptionRef.set(served, ["t3-mac.example.com"]);
    yield* SubscriptionRef.set(served, ["t3-mac.example.com", HOST]);
    expect(yield* Queue.take(events)).toBe("stop");
    // A give-back drops the host before the record moves back: start again.
    yield* SubscriptionRef.set(served, []);
    expect(yield* Queue.take(events)).toBe("start");
    expect(yield* Queue.size(events)).toBe(0);
  }),
);
