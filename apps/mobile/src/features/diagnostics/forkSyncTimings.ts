import { syncTimings } from "@t3tools/client-runtime/fork/syncTimings";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { AppState } from "react-native";

import { mobileApplicationActiveWakeup } from "../../connection/app-state-wakeups";

syncTimings.enable();

// One listener for the app. The wakeup stream starts a listener for each subscriber.
let backgroundedAtMs: number | null = AppState.currentState === "background" ? Date.now() : null;
AppState.addEventListener("change", (state) => {
  if (state === "background") {
    backgroundedAtMs = Date.now();
    return;
  }
  if (state === "active") {
    syncTimings.startRun(mobileApplicationActiveWakeup(backgroundedAtMs, Date.now()));
    backgroundedAtMs = null;
  }
});

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
