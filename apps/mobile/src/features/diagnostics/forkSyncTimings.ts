import { syncTimings } from "@t3tools/client-runtime/fork/syncTimings";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

// Wakeup runs start in the connection's own app-state listener (`connection/platform.ts`).
syncTimings.enable();

/** Records the sync spans of the local tracer and of the T3 Connect tracer that `tracing` builds. */
export function withSyncTimings<E, R>(tracing: Layer.Layer<never, E, R>) {
  return Layer.effectContext(
    Effect.gen(function* () {
      const local = yield* Tracer.Tracer;
      const relay = yield* RelayClientTracer;
      return Context.make(Tracer.Tracer, syncTimings.tracer(local)).pipe(
        Context.add(RelayClientTracer, Option.map(relay, syncTimings.tracer)),
      );
    }),
  ).pipe(Layer.provide(tracing));
}
