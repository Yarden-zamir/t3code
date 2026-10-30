import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";

import { makeSyncTimingsRecorder } from "./syncTimings.ts";

const MAC = EnvironmentId.make("mac");
const VPS = EnvironmentId.make("vps");

function makeRecorder(options?: { readonly maxWakeups?: number; readonly maxSpans?: number }) {
  const clock = { now: 1_000, epoch: 1_700_000_000_000 };
  const recorder = makeSyncTimingsRecorder({
    now: () => clock.now,
    epochNow: () => clock.epoch,
    ...(options?.maxWakeups === undefined ? {} : { maxWakeups: options.maxWakeups }),
    ...(options?.maxSpans === undefined ? {} : { maxSpansPerEnvironment: options.maxSpans }),
  });
  recorder.enable();
  const traced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Tracer.Tracer, recorder.tracer(Tracer.nativeTracer));
  const advance = (ms: number) => Effect.sync(() => (clock.now += ms));
  return { clock, recorder, traced, advance };
}

describe("syncTimings", () => {
  it.effect("groups recorded spans by the environment of the span or of a parent span", () =>
    Effect.gen(function* () {
      const { recorder, traced, advance } = makeRecorder();
      const checkRoute = advance(30).pipe(Effect.withSpan("ConnectionDriver.checkRoute"));
      yield* traced(
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan("connection.environment.id", MAC);
          yield* checkRoute;
          yield* advance(20).pipe(Effect.withSpan("unrelated.span"));
        }).pipe(Effect.withSpan("ConnectionDriver.connect")),
      );
      yield* traced(
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan("environment.id", VPS);
          yield* advance(5).pipe(Effect.withSpan("MobileEnvironmentCache.loadShell"));
        }).pipe(Effect.withSpan("EnvironmentShellState.make")),
      );
      yield* traced(advance(5).pipe(Effect.withSpan("ShellSnapshotLoader.load")));

      const { coldStart } = recorder.snapshot();
      expect([...coldStart.environments.keys()]).toEqual([MAC, VPS]);
      expect(coldStart.environments.get(MAC)).toMatchObject({
        marks: { socketReady: 50 },
        spans: [
          { name: "ConnectionDriver.checkRoute", startMs: 0, durationMs: 30, outcome: "success" },
          { name: "ConnectionDriver.connect", startMs: 0, durationMs: 50, outcome: "success" },
        ],
      });
      expect(coldStart.environments.get(VPS)?.spans).toEqual([
        {
          name: "MobileEnvironmentCache.loadShell",
          startMs: 50,
          durationMs: 5,
          outcome: "success",
        },
      ]);
    }),
  );

  it.effect("measures marks from the start of their run and keeps the first of each", () =>
    Effect.gen(function* () {
      const { clock, recorder, traced, advance } = makeRecorder();
      yield* advance(100);
      recorder.mark(MAC, "cached");
      yield* advance(50);
      recorder.mark(MAC, "cached");
      recorder.mark(MAC, "live");
      const slowConnect = traced(
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan("connection.environment.id", MAC);
          yield* advance(1_000);
          // A deep sleep moves the clock time, not the monotonic clock.
          clock.epoch += 3_600_000;
          recorder.startRun("application-active-long");
          yield* advance(200);
          recorder.mark(MAC, "synchronizing");
          recorder.probe(MAC, "silent");
        }).pipe(Effect.withSpan("ConnectionDriver.connect")),
      );
      yield* slowConnect;

      const { coldStart, wakeups } = recorder.snapshot();
      expect(coldStart.environments.get(MAC)).toMatchObject({
        marks: { cached: 100, live: 150, socketReady: 1_350 },
        spans: [{ name: "ConnectionDriver.connect", startMs: 150, durationMs: 1_200 }],
      });
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]?.trigger).toBe("application-active-long");
      expect(coldStart.startedAtEpochMs).toBe(1_700_000_000_000);
      expect(wakeups[0]?.startedAtEpochMs).toBe(1_700_003_600_000);
      expect(wakeups[0]?.environments.get(MAC)).toEqual({
        marks: { synchronizing: 200 },
        spans: [],
        droppedSpans: 0,
        probes: [{ atMs: 200, result: "silent" }],
      });
    }),
  );

  it.effect("keeps the cold start, the newest wakeups and a bounded span list", () =>
    Effect.gen(function* () {
      const { recorder, traced } = makeRecorder({ maxWakeups: 2, maxSpans: 1 });
      recorder.mark(MAC, "cached");
      recorder.startRun("application-active-probe");
      recorder.startRun("application-active-long");
      recorder.startRun("application-active-probe");
      // A second listener of the same return to the foreground starts no run.
      recorder.startRun("application-active-probe");
      const loadShell = Effect.void.pipe(
        Effect.withSpan("MobileEnvironmentCache.loadShell"),
        Effect.withSpan("parent", { attributes: { "environment.id": VPS } }),
      );
      yield* traced(Effect.all([loadShell, loadShell, loadShell]));

      const { coldStart, wakeups } = recorder.snapshot();
      expect(coldStart.environments.get(MAC)?.marks).toEqual({ cached: 0 });
      expect(wakeups.map((run) => run.trigger)).toEqual([
        "application-active-probe",
        "application-active-long",
      ]);
      expect(wakeups[0]?.environments.get(VPS)).toMatchObject({
        spans: [{ name: "MobileEnvironmentCache.loadShell" }],
        droppedSpans: 2,
      });
    }),
  );

  it.effect("follows the status of a shell or thread state", () =>
    Effect.gen(function* () {
      const { recorder, advance } = makeRecorder();
      const state = yield* SubscriptionRef.make<{ readonly status: string }>({ status: "cached" });
      yield* recorder.followStatus(MAC, state, { cached: "cached", live: "live" });
      yield* advance(40);
      yield* SubscriptionRef.set(state, { status: "synchronizing" });
      yield* advance(60);
      yield* SubscriptionRef.set(state, { status: "live" });
      yield* Effect.yieldNow;

      expect(recorder.snapshot().coldStart.environments.get(MAC)?.marks).toEqual({
        cached: 0,
        live: 100,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("records nothing before it is enabled", () =>
    Effect.gen(function* () {
      const recorder = makeSyncTimingsRecorder({ now: () => 0, epochNow: () => 0 });
      recorder.mark(MAC, "live");
      recorder.startRun("application-active-long");
      yield* Effect.void.pipe(
        Effect.withSpan("ConnectionDriver.connect", {
          attributes: { "connection.environment.id": MAC },
        }),
        Effect.provideService(Tracer.Tracer, recorder.tracer(Tracer.nativeTracer)),
      );

      const snapshot = recorder.snapshot();
      expect(snapshot.coldStart.environments.size).toBe(0);
      expect(snapshot.wakeups).toEqual([]);
    }),
  );
});
