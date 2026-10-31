/**
 * Fork: MM-1922 on kitshn (K-1610): each T3 tool call that this machine forwards over a link names
 * its tool to the link proxy, which records the target machine, the tool and the status. Never the
 * arguments or the output. It wraps upstream `PeerForwarding`, so a forwarded wait is named once,
 * not once for each piece that upstream sends.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import { KitshnAuditName } from "./MachinePeers.ts";

const named = <A, E, R>(tool: string, call: Effect.Effect<A, E, R>) =>
  Effect.provideService(call, KitshnAuditName, tool);

const make = Effect.gen(function* () {
  const upstream = yield* PeerForwarding.PeerForwarding;
  return PeerForwarding.PeerForwarding.of({
    ...upstream,
    // Untraced: the upstream operations hold the spans.
    call: Effect.fnUntraced(function* (scope, tool, environmentId, params) {
      return yield* named(tool.name, upstream.call(scope, tool, environmentId, params));
    }),
    readThread: Effect.fnUntraced(function* (scope, environmentId, input) {
      return yield* named("t3_thread_read", upstream.readThread(scope, environmentId, input));
    }),
    interruptThread: Effect.fnUntraced(function* (scope, environmentId, input) {
      return yield* named(
        "t3_thread_interrupt",
        upstream.interruptThread(scope, environmentId, input),
      );
    }),
    waitForThread: Effect.fnUntraced(function* (scope, environmentId, input) {
      return yield* named("t3_thread_wait", upstream.waitForThread(scope, environmentId, input));
    }),
  });
});

/** Upstream `PeerForwarding`, with each forwarded call named for the kitshn audit (MM-1922). */
export const layer = Layer.effect(PeerForwarding.PeerForwarding, make).pipe(
  Layer.provide(PeerForwarding.layer),
);
