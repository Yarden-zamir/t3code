import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";

const SYNC_TIMING_SPANS = [
  "MobileEnvironmentCache.loadShell",
  "ConnectionDriver.checkRoute",
  "clientRuntime.connection.remote.authorizeBearer",
  "ConnectionDriver.connect",
  "ShellSnapshotLoader.load",
  "EnvironmentSupervisor.awaitSilentSocket",
  "CacheWarmup.thread",
] as const;
export type SyncTimingSpan = (typeof SYNC_TIMING_SPANS)[number];

const SYNC_TIMING_MARKS = [
  "cached",
  "synchronizing",
  "socketReady",
  "httpSnapshotApplied",
  "live",
  "threadSynchronizing",
  "threadLive",
  "cacheWarmupStarted",
  "cacheWarmupDone",
] as const;
export type SyncTimingMark = (typeof SYNC_TIMING_MARKS)[number];

export type SyncRunTrigger = "cold-start" | "application-active-probe" | "application-active-long";
export type SyncProbeResult = "alive" | "silent" | "timed-out" | "failed";
type SyncOutcome = "success" | "failure" | "interrupted";

export interface SyncSpanTiming {
  readonly name: SyncTimingSpan;
  /** Milliseconds from the start of the run. */
  readonly startMs: number;
  readonly durationMs: number;
  readonly outcome: SyncOutcome;
}

export interface SyncEnvironmentTimings {
  readonly marks: Partial<Record<SyncTimingMark, number>>;
  readonly spans: ReadonlyArray<SyncSpanTiming>;
  readonly droppedSpans: number;
  readonly probes: ReadonlyArray<{ readonly atMs: number; readonly result: SyncProbeResult }>;
}

export interface SyncRun {
  readonly trigger: SyncRunTrigger;
  readonly startedAtEpochMs: number;
  readonly environments: ReadonlyMap<EnvironmentId, SyncEnvironmentTimings>;
}

export interface SyncTimingsSnapshot {
  readonly coldStart: SyncRun;
  /** Newest first. */
  readonly wakeups: ReadonlyArray<SyncRun>;
}

interface MutableEnvironmentTimings {
  marks: Partial<Record<SyncTimingMark, number>>;
  spans: Array<SyncSpanTiming>;
  droppedSpans: number;
  probes: Array<{ readonly atMs: number; readonly result: SyncProbeResult }>;
}

interface MutableRun {
  readonly trigger: SyncRunTrigger;
  readonly origin: number;
  readonly startedAtEpochMs: number;
  readonly environments: Map<EnvironmentId, MutableEnvironmentTimings>;
}

const ENVIRONMENT_ATTRIBUTES = ["connection.environment.id", "environment.id"] as const;
const RECORDED_SPANS: ReadonlySet<string> = new Set(SYNC_TIMING_SPANS);

function spanEnvironment(span: Tracer.AnySpan): EnvironmentId | undefined {
  let current: Tracer.AnySpan | undefined = span;
  while (current !== undefined) {
    if (current._tag === "Span") {
      for (const key of ENVIRONMENT_ATTRIBUTES) {
        const value = current.attributes.get(key);
        if (typeof value === "string") return value as EnvironmentId;
      }
      current = Option.getOrUndefined(current.parent);
    } else {
      current = undefined;
    }
  }
  return undefined;
}

function exitOutcome(exit: Exit.Exit<unknown, unknown>): SyncOutcome {
  if (Exit.isSuccess(exit)) return "success";
  return Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failure";
}

/**
 * Keeps the timings of the latest sync runs in memory only. A run starts at
 * the cold start or at a return to the foreground. The recorder does nothing
 * until `enable` is called, so clients without a diagnostics view pay nothing.
 */
export function makeSyncTimingsRecorder(options: {
  readonly now: () => number;
  readonly epochNow: () => number;
  readonly maxWakeups?: number;
  readonly maxSpansPerEnvironment?: number;
  readonly maxProbesPerEnvironment?: number;
}) {
  const maxWakeups = options.maxWakeups ?? 10;
  const maxSpans = options.maxSpansPerEnvironment ?? 40;
  const maxProbes = options.maxProbesPerEnvironment ?? 5;
  let enabled = false;
  const newRun = (trigger: SyncRunTrigger): MutableRun => ({
    trigger,
    origin: options.now(),
    startedAtEpochMs: options.epochNow(),
    environments: new Map(),
  });
  const coldStart = newRun("cold-start");
  const wakeups: Array<MutableRun> = [];
  let current = coldStart;

  const environment = (run: MutableRun, environmentId: EnvironmentId) => {
    let timings = run.environments.get(environmentId);
    if (timings === undefined) {
      timings = { marks: {}, spans: [], droppedSpans: 0, probes: [] };
      run.environments.set(environmentId, timings);
    }
    return timings;
  };
  const markIn = (run: MutableRun, environmentId: EnvironmentId, mark: SyncTimingMark) => {
    const timings = environment(run, environmentId);
    if (timings.marks[mark] !== undefined) return;
    timings.marks[mark] = Math.round(options.now() - run.origin);
  };

  // Each subscriber of the wakeup stream has its own app-state listener, so one return to the
  // foreground calls startRun once per listener. Only the first call after leaving starts a run.
  let leftForeground = false;
  const markLeftForeground = () => {
    leftForeground = true;
  };

  const startRun = (trigger: Exclude<SyncRunTrigger, "cold-start">) => {
    if (!enabled || !leftForeground) return;
    leftForeground = false;
    current = newRun(trigger);
    wakeups.unshift(current);
    if (wakeups.length > maxWakeups) wakeups.length = maxWakeups;
  };

  const mark = (environmentId: EnvironmentId, name: SyncTimingMark) => {
    if (enabled) markIn(current, environmentId, name);
  };

  const probe = (environmentId: EnvironmentId, result: SyncProbeResult) => {
    if (!enabled) return;
    const timings = environment(current, environmentId);
    if (timings.probes.length >= maxProbes) return;
    timings.probes.push({ atMs: Math.round(options.now() - current.origin), result });
  };

  const recordSpan = (
    run: MutableRun,
    span: Tracer.Span,
    startedAt: number,
    exit: Exit.Exit<unknown, unknown>,
  ) => {
    const environmentId = spanEnvironment(span);
    if (environmentId === undefined) return;
    const outcome = exitOutcome(exit);
    if (span.name === "ConnectionDriver.connect" && outcome === "success") {
      markIn(run, environmentId, "socketReady");
    }
    pushTiming(run, environmentId, span.name as SyncTimingSpan, startedAt, outcome);
  };

  const pushTiming = (
    run: MutableRun,
    environmentId: EnvironmentId,
    name: SyncTimingSpan,
    startedAt: number,
    outcome: SyncOutcome,
  ) => {
    const timings = environment(run, environmentId);
    if (timings.spans.length >= maxSpans) {
      timings.droppedSpans += 1;
      return;
    }
    timings.spans.push({
      name,
      startMs: Math.round(startedAt - run.origin),
      durationMs: Math.round(options.now() - startedAt),
      outcome,
    });
  };

  /** Starts a timed step outside a tracer span. Call the result when the step ends. */
  const startStep = (environmentId: EnvironmentId, name: SyncTimingSpan) => {
    const run = current;
    const startedAt = options.now();
    return (outcome: SyncOutcome) => {
      if (enabled) pushTiming(run, environmentId, name, startedAt, outcome);
    };
  };

  /** Wraps a tracer so that the spans in `SYNC_TIMING_SPANS` also land in the recorder. */
  const tracer = (delegate: Tracer.Tracer): Tracer.Tracer =>
    Tracer.make({
      span(spanOptions) {
        const span = delegate.span(spanOptions);
        if (!enabled || !RECORDED_SPANS.has(spanOptions.name)) return span;
        const run = current;
        const startedAt = options.now();
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          recordSpan(run, span, startedAt, exit);
        };
        return span;
      },
      ...(delegate.context ? { context: delegate.context } : {}),
    });

  /**
   * Marks the first time per run that a shell or thread state reaches each
   * status. A status that a later one replaces before the follower subscribes
   * is not marked.
   */
  const followStatus = Effect.fnUntraced(function* <S extends { readonly status: string }>(
    environmentId: EnvironmentId,
    state: SubscriptionRef.SubscriptionRef<S>,
    marks: Partial<Record<S["status"], SyncTimingMark>>,
  ): Effect.fn.Return<void, never, Scope.Scope> {
    if (!enabled) return;
    const markStatus = (status: S["status"]) => {
      const name = marks[status];
      if (name !== undefined) mark(environmentId, name);
    };
    markStatus((yield* SubscriptionRef.get(state)).status);
    yield* SubscriptionRef.changes(state).pipe(
      Stream.map((value): S["status"] => value.status),
      Stream.changes,
      Stream.runForEach((status) => Effect.sync(() => markStatus(status))),
      Effect.forkScoped({ startImmediately: true }),
    );
  });

  const freeze = (run: MutableRun): SyncRun => ({
    trigger: run.trigger,
    startedAtEpochMs: run.startedAtEpochMs,
    environments: new Map(
      Array.from(run.environments, ([environmentId, timings]) => [
        environmentId,
        {
          marks: { ...timings.marks },
          spans: [...timings.spans],
          droppedSpans: timings.droppedSpans,
          probes: [...timings.probes],
        },
      ]),
    ),
  });

  return {
    enable: () => {
      enabled = true;
    },
    get enabled() {
      return enabled;
    },
    leftForeground: markLeftForeground,
    startRun,
    mark,
    probe,
    tracer,
    followStatus,
    startStep,
    snapshot: (): SyncTimingsSnapshot => ({
      coldStart: freeze(coldStart),
      wakeups: wakeups.map(freeze),
    }),
  };
}

export type SyncTimingsRecorder = ReturnType<typeof makeSyncTimingsRecorder>;

// One app-wide recorder keeps each upstream hook one line; revisit for a recorder per runtime.
// The cold start counts from when this module loads. Durations use performance.now(); run
// times use Date, because Android stops performance.now() in deep sleep.
export const syncTimings: SyncTimingsRecorder = makeSyncTimingsRecorder({
  now: () => performance.now(),
  // @effect-diagnostics-next-line globalDate:off
  epochNow: () => Date.now(),
});

const MARK_LABELS: Record<SyncTimingMark, string> = {
  cached: "cached list shown",
  synchronizing: "synchronizing",
  socketReady: "socket ready",
  httpSnapshotApplied: "HTTP snapshot applied",
  live: "live",
  threadSynchronizing: "open thread synchronizing",
  threadLive: "open thread live",
  cacheWarmupStarted: "cache warm-up started",
  cacheWarmupDone: "cache warm-up done",
};

const SPAN_LABELS: Record<SyncTimingSpan, string> = {
  "MobileEnvironmentCache.loadShell": "load cached shell",
  "ConnectionDriver.checkRoute": "check route",
  "clientRuntime.connection.remote.authorizeBearer": "authorize bearer",
  "ConnectionDriver.connect": "connect",
  "ShellSnapshotLoader.load": "HTTP snapshot",
  "EnvironmentSupervisor.awaitSilentSocket": "silent socket check",
  "CacheWarmup.thread": "cache warm-up thread",
};

function runTitle(run: SyncRun): string {
  const at = Option.match(DateTime.make(Math.round(run.startedAtEpochMs)), {
    onNone: () => "at an unknown time",
    onSome: DateTime.formatIso,
  });
  return run.trigger === "cold-start"
    ? `Cold start ${at} (ms since the app code loaded)`
    : `Wakeup ${run.trigger} ${at} (ms since foreground)`;
}

/** Plain text, one block per run and environment. Holds labels, never addresses. */
export function formatSyncRun(run: SyncRun, label: (environmentId: EnvironmentId) => string) {
  const lines = [runTitle(run)];
  if (run.environments.size === 0) lines.push("  no sync activity");
  for (const [environmentId, timings] of run.environments) {
    lines.push(`  ${label(environmentId)}`);
    for (const name of SYNC_TIMING_MARKS) {
      const at = timings.marks[name];
      if (at !== undefined)
        lines.push(`    ${MARK_LABELS[name].padEnd(26)}${String(at).padStart(7)}`);
    }
    for (const probe of timings.probes) {
      lines.push(`    ${`probe ${probe.result}`.padEnd(26)}${String(probe.atMs).padStart(7)}`);
    }
    for (const span of timings.spans) {
      const outcome = span.outcome === "success" ? "" : ` ${span.outcome}`;
      lines.push(
        `    ${SPAN_LABELS[span.name].padEnd(26)}${String(span.startMs).padStart(7)} +${span.durationMs}${outcome}`,
      );
    }
    if (timings.droppedSpans > 0) lines.push(`    ${timings.droppedSpans} more spans not kept`);
  }
  return lines.join("\n");
}
