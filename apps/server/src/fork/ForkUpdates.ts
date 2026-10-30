/**
 * Fork: installs fork releases through the upstream self-update of a `t3 service install` server.
 * With `forkAutoUpdate`, a check every 5 minutes installs when no turn, background shell or
 * terminal thread program runs. A program holds it at most TERMINAL_HOLD_MAX, gets a notice, and
 * the update installs TERMINAL_HOLD_NOTICE_LEAD later. Desktop "Install when idle": `terminalHold`.
 */
import {
  type ForkUpdateTerminalHold,
  TERMINAL_THREAD_INSTANCE_ID,
  TERMINAL_UPDATE_HOLD_MAX_HOURS,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import { parseServiceState, SERVICE_STATE_FILE } from "../cloud/serviceProtocol.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { type ForkUpdateChannel, newerForkRelease } from "./forkReleases.ts";

// Each check reads the GitHub release index once. Unauthenticated, GitHub
// allows 60 requests an hour for each address.
const CHECK_INTERVAL = Duration.minutes(5);

/**
 * A program in a terminal thread holds an update at most this long, counted from the first
 * check that finds a newer release. Builds and test runs end well within it, so they never lose
 * their work. A dev server or a CLI agent left open runs for days, and without a maximum the
 * machine would stay on an old release. Six hours lets a machine update on the same day.
 */
export const TERMINAL_HOLD_MAX = Duration.hours(TERMINAL_UPDATE_HOLD_MAX_HOURS);
/** The time between the notice in each held terminal and the update. */
export const TERMINAL_HOLD_NOTICE_LEAD = Duration.minutes(10);
// The desktop install waits in front of the user, so it checks more often than the headless one.
// Only a running program makes a check read the thread snapshot.
export const DESKTOP_TERMINAL_HOLD_CHECK_INTERVAL = Duration.seconds(30);

const TERMINAL_HOLD_NOTICE =
  "\r\n[T3 Code] A newer T3 Code waits for this program. In about 10 minutes it installs, " +
  "the server restarts and this program ends.\r\n";

export type TerminalHold = { readonly since: number; readonly noticedAt: number | null } | null;

/** One check with a newer release and no agent work: install, wait, or print the notice. */
export function nextTerminalHold(
  hold: TerminalHold,
  terminalProgramsRun: boolean,
  nowMs: number,
): { readonly action: "install" | "wait" | "notify"; readonly hold: TerminalHold } {
  if (!terminalProgramsRun) return { action: "install", hold: null };
  if (hold === null) return { action: "wait", hold: { since: nowMs, noticedAt: null } };
  if (nowMs - hold.since < Duration.toMillis(TERMINAL_HOLD_MAX)) return { action: "wait", hold };
  if (hold.noticedAt === null) return { action: "notify", hold: { ...hold, noticedAt: nowMs } };
  if (nowMs - hold.noticedAt < Duration.toMillis(TERMINAL_HOLD_NOTICE_LEAD)) {
    return { action: "wait", hold };
  }
  return { action: "install", hold: null };
}

export class ForkUpdateError extends Schema.TaggedError<ForkUpdateError>()("ForkUpdateError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export class ForkUpdates extends Context.Service<
  ForkUpdates,
  {
    /** This server runs as the background service, so it installs fork releases itself. */
    readonly available: boolean;
    /** The machine map `installUpdate` command. The result has the shape of the desktop result. */
    readonly install: (input: {
      readonly whenIdle: boolean;
    }) => Effect.Effect<{ readonly version: string; readonly whenIdle: boolean }, ForkUpdateError>;
    /**
     * The terminal thread programs that hold a desktop "Install when idle", which started at
     * `heldSince` (epoch ms). The headless hold rules apply, and the stream prints the notice.
     */
    readonly terminalHold: (heldSince: number) => Stream.Stream<ForkUpdateTerminalHold>;
    /** K-717: the release feed that updates follow, from the T3 card. Nightly until kitshn says. */
    readonly setChannel: (channel: ForkUpdateChannel) => Effect.Effect<void>;
  }
>()("t3/fork/ForkUpdates") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const terminals = yield* TerminalManager.TerminalManager;
  const settings = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;

  const available = config.mode !== "desktop" && launcher.managed;
  // The machine map asked for an install at the next idle check.
  const installWhenIdle = yield* Ref.make(false);
  const headlessHold = yield* Ref.make<TerminalHold>(null);

  const channel = yield* Ref.make<ForkUpdateChannel>("nightly");
  const newerRelease = Ref.get(channel).pipe(
    Effect.flatMap((current) => newerForkRelease(httpClient, packageJson.version, current)),
    Effect.mapError((error) => new ForkUpdateError({ reason: error.message })),
  );

  // Terminals that run a program. The restart kills a program in a terminal thread, and nothing
  // wakes it again, so such a program holds the update up to TERMINAL_HOLD_MAX. A multiplexer
  // would keep the program through a restart.
  const busyTerminals = yield* Ref.make<ReadonlyMap<string, TerminalSummary>>(new Map());
  const keyOf = (terminal: { threadId: string; terminalId: string }) =>
    `${terminal.threadId}\u0000${terminal.terminalId}`;
  const unsubscribeTerminals = yield* terminals.subscribeMetadata((event) =>
    Ref.update(busyTerminals, (current) => {
      const next = new Map(current);
      if (event.type === "snapshot") {
        next.clear();
        for (const terminal of event.terminals) next.set(keyOf(terminal), terminal);
      } else if (event.type === "upsert") {
        next.set(keyOf(event.terminal), event.terminal);
      } else {
        next.delete(keyOf(event));
      }
      return next;
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribeTerminals));

  // A background shell blocks: the restart kills it and recovery wakes the thread. Limit: a shell
  // that never ends, such as a dev server, blocks auto-update. Revisit if updates stall on those.
  // Other tasks do not block. Pull request watches survive a restart, and the restart continuation
  // resumes native subagents and awaited monitors. They run for hours, so waiting holds updates.
  const busyPrograms = Ref.get(busyTerminals).pipe(
    Effect.map((running) =>
      [...running.values()].filter(
        (terminal) => terminal.hasRunningSubprocess && terminal.status === "running",
      ),
    ),
  );
  const inTerminalThreads = (
    programs: ReadonlyArray<TerminalSummary>,
    shells: ReadonlyArray<{ readonly id: string; readonly providerInstanceId: string }>,
  ) => {
    const terminalThreadIds = new Set(
      shells
        .filter((thread) => thread.providerInstanceId === TERMINAL_THREAD_INSTANCE_ID)
        .map((thread) => thread.id),
    );
    return programs.filter((terminal) => terminalThreadIds.has(terminal.threadId));
  };
  const runningWork = Effect.gen(function* () {
    const snapshot = yield* threads.getShellSnapshot();
    return {
      agents: snapshot.threads.some(
        (thread) =>
          thread.activeRunId !== null ||
          (thread.pendingBackgroundTasks ?? []).some((task) => task.kind === "command"),
      ),
      terminalPrograms: inTerminalThreads(yield* busyPrograms, snapshot.threads),
    };
  }).pipe(Effect.orElseSucceed(() => ({ agents: true, terminalPrograms: [] })));
  const printHoldNotices = (programs: ReadonlyArray<TerminalSummary>) =>
    Effect.forEach(
      programs,
      (terminal) =>
        terminals.forkPrintNotice({
          threadId: terminal.threadId,
          terminalId: terminal.terminalId,
          text: TERMINAL_HOLD_NOTICE,
        }),
      { discard: true },
    );

  // The launcher records the last update. A version that rolled back or failed
  // is not tried again, so a broken release does not cause a restart loop.
  const lastFailedVersion = fs
    .readFileString(path.join(config.baseDir, "runtime", SERVICE_STATE_FILE))
    .pipe(
      Effect.map((text) => {
        const update = parseServiceState(text)?.update;
        return update?.status === "rolled-back" || update?.status === "failed"
          ? update.targetVersion
          : null;
      }),
      Effect.orElseSucceed(() => null),
    );

  // On success the launcher replaces this process with the new version.
  const runUpdate = (version: string) =>
    selfUpdate.update({ targetVersion: version }).pipe(
      Effect.tap(() => Effect.logInfo("Fork update handed to the service launcher.", { version })),
      Effect.catch((error) =>
        Effect.logWarning("Fork update failed.", { version, reason: error.reason }),
      ),
    );

  const check = Effect.gen(function* () {
    const { forkAutoUpdate } = yield* settings.getSettings;
    if (!(forkAutoUpdate || (yield* Ref.get(installWhenIdle)))) return;
    const work = yield* runningWork;
    if (work.agents) return;
    const version = yield* newerRelease;
    if (version === undefined) {
      yield* Ref.set(installWhenIdle, false);
      yield* Ref.set(headlessHold, null);
      return;
    }
    if (version === (yield* lastFailedVersion)) return;
    const step = nextTerminalHold(
      yield* Ref.get(headlessHold),
      work.terminalPrograms.length > 0,
      yield* Clock.currentTimeMillis,
    );
    yield* Ref.set(headlessHold, step.hold);
    if (step.action === "notify") yield* printHoldNotices(work.terminalPrograms);
    if (step.action === "install") yield* runUpdate(version);
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Fork update check failed.", { cause })));

  if (available) {
    yield* check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)), Effect.forkScoped);
  }

  const install: ForkUpdates["Service"]["install"] = Effect.fn("ForkUpdates.install")(function* ({
    whenIdle,
  }) {
    if (!available) {
      return yield* new ForkUpdateError({
        reason: "This server does not run as the T3 Code background service.",
      });
    }
    const version = yield* newerRelease;
    if (version === undefined) {
      return yield* new ForkUpdateError({
        reason: `No fork release is newer than ${packageJson.version}.`,
      });
    }
    if (whenIdle) {
      yield* Ref.set(installWhenIdle, true);
    } else {
      // Reply first: the update ends this process.
      yield* runUpdate(version).pipe(Effect.forkIn(scope));
    }
    return { version, whenIdle };
  });

  const terminalHold: ForkUpdates["Service"]["terminalHold"] = (heldSince) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // The hold keeps counting from `heldSince` when programs stop and start again.
        const started: TerminalHold = { since: heldSince, noticedAt: null };
        const hold = yield* Ref.make(started);
        const check = Effect.gen(function* () {
          const busy = yield* busyPrograms;
          const programs =
            busy.length === 0
              ? []
              : inTerminalThreads(busy, (yield* threads.getShellSnapshot()).threads);
          const step = nextTerminalHold(
            yield* Ref.get(hold),
            programs.length > 0,
            yield* Clock.currentTimeMillis,
          );
          yield* Ref.set(hold, step.hold ?? started);
          if (step.action === "notify") yield* printHoldNotices(programs);
          return { ready: step.action === "install" };
        }).pipe(
          // A failed check holds, as `runningWork` does: an update must not end a program.
          Effect.catchCause((cause) =>
            Effect.logWarning("Fork desktop update hold check failed.", { cause }).pipe(
              Effect.as({ ready: false }),
            ),
          ),
        );
        return Stream.tick(DESKTOP_TERMINAL_HOLD_CHECK_INTERVAL).pipe(
          Stream.mapEffect(() => check),
          Stream.changesWith((left, right) => left.ready === right.ready),
        );
      }),
    );

  return ForkUpdates.of({
    available,
    install,
    terminalHold,
    setChannel: Effect.fn("ForkUpdates.setChannel")(function* (next) {
      yield* Ref.set(channel, next);
    }),
  });
});

export const layer = Layer.effect(ForkUpdates, make);
