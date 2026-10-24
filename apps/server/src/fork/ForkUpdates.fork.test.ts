import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  type ForkUpdateTerminalHold,
  TERMINAL_THREAD_INSTANCE_ID,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ForkUpdates from "./ForkUpdates.ts";
import { nextTerminalHold, TERMINAL_HOLD_MAX, TERMINAL_HOLD_NOTICE_LEAD } from "./ForkUpdates.ts";

const max = Duration.toMillis(TERMINAL_HOLD_MAX);
const lead = Duration.toMillis(TERMINAL_HOLD_NOTICE_LEAD);

describe("nextTerminalHold", () => {
  it("installs at once when no terminal thread program runs", () => {
    expect(nextTerminalHold(null, false, 0)).toEqual({ action: "install", hold: null });
    expect(nextTerminalHold({ since: 0, noticedAt: null }, false, 1).action).toBe("install");
  });

  it("holds for the maximum, then prints the notice, then installs after the lead", () => {
    let step = nextTerminalHold(null, true, 0);
    expect(step.action).toBe("wait");
    step = nextTerminalHold(step.hold, true, max - 1);
    expect(step.action).toBe("wait");
    step = nextTerminalHold(step.hold, true, max);
    expect(step.action).toBe("notify");
    // The notice goes out once.
    step = nextTerminalHold(step.hold, true, max + lead - 1);
    expect(step.action).toBe("wait");
    step = nextTerminalHold(step.hold, true, max + lead);
    expect(step).toEqual({ action: "install", hold: null });
  });
});

const program = (threadId: string, running: boolean): TerminalSummary => ({
  threadId,
  terminalId: "default",
  cwd: "/work",
  worktreePath: null,
  status: "running",
  pid: 1,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: running,
  label: "Terminal",
  updatedAt: "2026-10-24T00:00:00.000Z",
});

/** The desktop hold of one terminal thread (`thread:terminal`) and one agent thread. */
const desktopHold = Effect.gen(function* () {
  const listeners: Array<(event: TerminalMetadataStreamEvent) => Effect.Effect<void>> = [];
  const notices = yield* Queue.unbounded<string>();
  const services = yield* Layer.build(
    ForkUpdates.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-updates-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          // Not the background service, so no headless update check runs.
          Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({ managed: false }),
          Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: () =>
              Effect.succeed({
                threads: [
                  { id: "thread:terminal", providerInstanceId: TERMINAL_THREAD_INSTANCE_ID },
                  { id: "thread:agent", providerInstanceId: "codex" },
                ],
              } as never),
          }),
          Layer.mock(TerminalManager.TerminalManager)({
            subscribeMetadata: (listener) =>
              Effect.sync(() => {
                listeners.push(listener);
                return () => {};
              }),
            forkPrintNotice: ({ threadId }) => Queue.offer(notices, threadId).pipe(Effect.asVoid),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({}),
          FetchHttpClient.layer,
          NodeServices.layer,
        ),
      ),
    ),
  );
  const forkUpdates = Context.get(services, ForkUpdates.ForkUpdates);
  const setTerminals = (terminals: ReadonlyArray<TerminalSummary>) =>
    Effect.forEach(listeners, (listener) => listener({ type: "snapshot", terminals }), {
      discard: true,
    });
  const holds = yield* Queue.unbounded<ForkUpdateTerminalHold>();
  const watch = forkUpdates.terminalHold(0).pipe(
    Stream.runForEach((hold) => Queue.offer(holds, hold)),
    Effect.forkScoped,
  );
  return { setTerminals, notices, holds, watch };
});

describe("ForkUpdates.terminalHold (desktop Install when idle)", () => {
  effectIt.effect("is ready at once when only agent threads run programs", () =>
    Effect.gen(function* () {
      const hold = yield* desktopHold;
      yield* hold.setTerminals([program("thread:agent", true)]);
      yield* hold.watch;
      expect(yield* Queue.take(hold.holds)).toEqual({ ready: true });
    }),
  );

  effectIt.effect("waits for a terminal thread program and is ready when it ends", () =>
    Effect.gen(function* () {
      const hold = yield* desktopHold;
      yield* hold.setTerminals([program("thread:terminal", true)]);
      yield* hold.watch;
      expect(yield* Queue.take(hold.holds)).toEqual({ ready: false });
      yield* hold.setTerminals([program("thread:terminal", false)]);
      yield* TestClock.adjust(ForkUpdates.DESKTOP_TERMINAL_HOLD_CHECK_INTERVAL);
      expect(yield* Queue.take(hold.holds)).toEqual({ ready: true });
      expect(yield* Queue.size(hold.notices)).toBe(0);
    }),
  );

  effectIt.effect("holds at most the maximum, then prints the notice and is ready after it", () =>
    Effect.gen(function* () {
      const hold = yield* desktopHold;
      yield* hold.setTerminals([program("thread:terminal", true)]);
      yield* hold.watch;
      expect(yield* Queue.take(hold.holds)).toEqual({ ready: false });
      yield* TestClock.adjust(TERMINAL_HOLD_MAX);
      expect(yield* Queue.take(hold.notices)).toBe("thread:terminal");
      expect(yield* Queue.size(hold.holds)).toBe(0);
      yield* TestClock.adjust(TERMINAL_HOLD_NOTICE_LEAD);
      expect(yield* Queue.take(hold.holds)).toEqual({ ready: true });
    }),
  );
});
