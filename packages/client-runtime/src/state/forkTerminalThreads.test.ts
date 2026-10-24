import {
  EnvironmentId,
  ProviderInstanceId,
  TERMINAL_THREAD_INSTANCE_ID,
  ThreadId,
  type TerminalAttention,
  type TerminalSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  forkEffectiveSnoozed,
  forkInboxReturnAt,
  forkThreadIsWorking,
  forkThreadWokeAt,
  selectTerminalThreadStates,
  terminalStateOf,
  terminalThreadRowStatus,
  terminalThreadStatusLabel,
  type TerminalThreadState,
} from "./forkTerminalThreads.ts";

const visited = "2026-10-23T10:00:00.000Z";
const before = "2026-10-23T09:00:00.000Z";
const after = "2026-10-23T11:00:00.000Z";

describe("terminalThreadStatusLabel", () => {
  it("maps session failure and start before attention", () => {
    expect(
      terminalThreadStatusLabel(
        {
          status: "error",
          attention: { kind: "bell", at: after },
          running: false,
          failedAt: after,
        },
        visited,
      ),
    ).toBe("Error");
    expect(
      terminalThreadStatusLabel(
        { status: "starting", attention: null, running: false, failedAt: null },
        visited,
      ),
    ).toBe("Connecting");
  });

  it("maps unseen attention to a pill and seen attention to none", () => {
    const running = (kind: "bell" | "finished", at: string) =>
      terminalThreadStatusLabel(
        { status: "running", attention: { kind, at }, running: false, failedAt: null },
        visited,
      );
    expect(running("bell", after)).toBe("Awaiting Input");
    expect(running("finished", after)).toBe("Completed");
    expect(running("bell", before)).toBeNull();
  });

  it("maps an unseen program end to Error for a non-zero exit code and to Completed otherwise", () => {
    const finished = (exitCode: number | null | undefined, at = after) =>
      terminalThreadStatusLabel(
        {
          status: "running",
          attention: { kind: "finished", at, ...(exitCode === undefined ? {} : { exitCode }) },
          running: false,
          failedAt: null,
        },
        visited,
      );
    expect(finished(1)).toBe("Error");
    expect(finished(0)).toBe("Completed");
    expect(finished(null)).toBe("Completed");
    expect(finished(undefined)).toBe("Completed");
    expect(finished(1, before)).toBeNull();
  });

  it("treats everything as unseen for a thread that nobody opened", () => {
    expect(
      terminalThreadStatusLabel(
        {
          status: "running",
          attention: { kind: "finished", at: before, exitCode: 5 },
          running: false,
          failedAt: null,
        },
        null,
      ),
    ).toBe("Error");
  });

  it("shows a running program as Working, below a bell that asks for input", () => {
    const state = (running: boolean, kind: "bell" | "finished") =>
      terminalThreadStatusLabel(
        { status: "running", attention: { kind, at: after, exitCode: 1 }, running, failedAt: null },
        visited,
      );
    expect(state(true, "finished")).toBe("Working");
    expect(state(true, "bell")).toBe("Awaiting Input");
    expect(state(false, "finished")).toBe("Error");
  });

  it("shows a failed start until the user visits the thread after it", () => {
    const failed = (failedAt: string) =>
      terminalThreadStatusLabel(
        { status: "error", attention: null, running: false, failedAt },
        visited,
      );
    expect(failed(after)).toBe("Error");
    expect(failed(before)).toBeNull();
    expect(
      statesOf(summary("shell", { status: "error", updatedAt: after }))
        .values()
        .next().value,
    ).toMatchObject({ failedAt: after });
  });

  it("shows nothing for a thread without terminal state", () => {
    expect(terminalThreadStatusLabel(undefined, visited)).toBeNull();
  });

  it("orders the states: session error, start, unseen bell, running program, unseen end", () => {
    const label = (state: Partial<TerminalThreadState>) =>
      terminalThreadStatusLabel(
        { status: "running", attention: null, running: false, failedAt: null, ...state },
        visited,
      );
    const bell: TerminalAttention = { kind: "bell", at: after };
    // The program that rang the bell ended later, and its end replaced the bell.
    const failedAfterBell: TerminalAttention = {
      kind: "finished",
      at: after,
      exitCode: 1,
      bellAt: after,
    };
    expect(label({ status: "error", attention: bell, failedAt: after })).toBe("Error");
    expect(label({ status: "starting", attention: bell })).toBe("Connecting");
    expect(label({ attention: bell, running: true })).toBe("Awaiting Input");
    expect(label({ attention: failedAfterBell })).toBe("Awaiting Input");
    expect(label({ attention: failedAfterBell, running: true })).toBe("Awaiting Input");
    // A visit after the bell clears Input, and the end after the visit shows.
    expect(label({ attention: { ...failedAfterBell, bellAt: before } })).toBe("Error");
    expect(label({ attention: { ...failedAfterBell, bellAt: before }, running: true })).toBe(
      "Working",
    );
  });
});

describe("terminalThreadRowStatus", () => {
  it("fills in an idle row, and a bell also replaces a message run that works", () => {
    expect(terminalThreadRowStatus("ready", "Awaiting Input")).toBe("input");
    expect(terminalThreadRowStatus("working", "Awaiting Input")).toBe("input");
    expect(terminalThreadRowStatus("approval", "Awaiting Input")).toBe("approval");
    expect(terminalThreadRowStatus("waiting", "Error")).toBe("failed");
    expect(terminalThreadRowStatus("working", "Error")).toBe("working");
    expect(terminalThreadRowStatus("ready", "Completed")).toBe("ready");
    expect(terminalThreadRowStatus("ready", "Working")).toBe("working");
  });
});

const environmentId = EnvironmentId.make("environment-1");

function summary(threadId: string, overrides: Partial<TerminalSummary> = {}): TerminalSummary {
  return {
    threadId,
    terminalId: "term-1",
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 1,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: "Terminal",
    updatedAt: before,
    ...overrides,
  };
}

function thread(id: string, kind: "terminal" | "agent" = "terminal") {
  return {
    id: ThreadId.make(id),
    environmentId,
    providerInstanceId:
      kind === "terminal" ? TERMINAL_THREAD_INSTANCE_ID : ProviderInstanceId.make("codex"),
    lastVisitedAt: visited,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestRun: null,
    runtime: null,
    snoozedAt: visited,
    snoozedUntil: "2026-10-24T09:00:00.000Z",
  };
}

const statesOf = (...summaries: TerminalSummary[]) =>
  selectTerminalThreadStates([[environmentId, summaries]]);

describe("terminalStateOf", () => {
  it("reads only the main terminal of a terminal thread", () => {
    const states = statesOf(
      summary("shell", { hasRunningSubprocess: true }),
      summary("agent", { hasRunningSubprocess: true }),
      summary("drawer", { terminalId: "term-2", hasRunningSubprocess: true }),
    );
    expect(terminalStateOf(states, thread("shell"))?.running).toBe(true);
    expect(terminalStateOf(states, thread("agent", "agent"))).toBeUndefined();
    expect(terminalStateOf(states, thread("drawer"))).toBeUndefined();
  });
});

describe("forkThreadIsWorking", () => {
  it("puts a terminal thread on the Working shelf while a program runs, until a bell asks", () => {
    const working = (overrides: Partial<TerminalSummary>) =>
      forkThreadIsWorking(
        thread("shell"),
        terminalStateOf(statesOf(summary("shell", overrides)), thread("shell")),
      );
    expect(working({ hasRunningSubprocess: true })).toBe(true);
    expect(working({ hasRunningSubprocess: false })).toBe(false);
    expect(working({ hasRunningSubprocess: true, attention: { kind: "bell", at: after } })).toBe(
      false,
    );
  });
});

describe("forkInboxReturnAt", () => {
  it("returns a terminal thread to the top when it rings or its program ends", () => {
    const states = statesOf(summary("shell", { attention: { kind: "finished", at: after } }));
    const returnAt = forkInboxReturnAt(() => Date.parse(visited), states);
    expect(returnAt(thread("shell"))).toBe(Date.parse(after));
    expect(returnAt(thread("agent", "agent"))).toBe(Date.parse(visited));
    expect(forkInboxReturnAt(undefined, states)(thread("other"))).toBeUndefined();
  });
});

describe("forkEffectiveSnoozed", () => {
  const snooze = (attention: TerminalAttention) => {
    const shell = thread("shell");
    const terminal = terminalStateOf(statesOf(summary("shell", { attention })), shell);
    return {
      snoozed: forkEffectiveSnoozed(shell, { now: after }, terminal),
      wokeAt: forkThreadWokeAt(shell, { now: after }, terminal),
    };
  };

  it("wakes a snoozed terminal thread on a bell or a failed program after the snooze", () => {
    expect(snooze({ kind: "bell", at: after })).toEqual({ snoozed: false, wokeAt: after });
    expect(snooze({ kind: "finished", at: after, exitCode: 2 })).toEqual({
      snoozed: false,
      wokeAt: after,
    });
  });

  it("wakes it for a program that ended after the snooze, like a finished agent run", () => {
    expect(snooze({ kind: "finished", at: after, exitCode: 0 })).toEqual({
      snoozed: false,
      wokeAt: after,
    });
  });

  it("keeps it asleep for attention from before the snooze", () => {
    expect(snooze({ kind: "bell", at: before })).toEqual({ snoozed: true, wokeAt: null });
    expect(snooze({ kind: "finished", at: before, exitCode: 1 })).toEqual({
      snoozed: true,
      wokeAt: null,
    });
  });
});
