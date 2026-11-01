import {
  EnvironmentId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ShellThreadStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countRunningAgentTurns,
  countRunningTerminalPrograms,
  nextAutomaticArm,
} from "./desktopUpdateIdleInstall.logic";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");

function thread(
  environmentId: EnvironmentId,
  status: OrchestrationV2ShellThreadStatus,
  pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = [],
) {
  return { environmentId, source: { status }, pendingBackgroundTasks };
}

describe("countRunningAgentTurns", () => {
  it("counts turns that are queued or in progress, not drained or finished ones", () => {
    const threads = (
      [
        "preparing",
        "queued",
        "starting",
        "running",
        "waiting",
        "idle",
        "completed",
        "interrupted",
        "failed",
        "cancelled",
        "rolled_back",
      ] as const
    ).map((status) => thread(primary, status));

    expect(countRunningAgentTurns(threads, primary)).toBe(4);
  });

  it("counts a finished turn whose background command runs, as the server update does", () => {
    const threads = [
      thread(primary, "completed", [{ taskId: "typecheck", kind: "command" }]),
      // The restart continuation resumes these, so they do not hold the update.
      thread(primary, "completed", [
        { taskId: "watch", kind: "monitor" },
        { taskId: "child", kind: "subagent" },
      ]),
    ];

    expect(countRunningAgentTurns(threads, primary)).toBe(1);
  });

  it("counts only the environment that the update restarts", () => {
    const threads = [thread(primary, "running"), thread(remote, "running")];

    expect(countRunningAgentTurns(threads, primary)).toBe(1);
    expect(countRunningAgentTurns(threads, null)).toBe(0);
  });
});

describe("countRunningTerminalPrograms", () => {
  it("counts the terminal threads of the restarted environment whose program runs", () => {
    const running = { status: "running", attention: null, running: true, failedAt: null } as const;
    const threads = [
      { environmentId: primary, terminal: running },
      { environmentId: primary, terminal: { ...running, running: false } },
      // An agent thread has no terminal state.
      { environmentId: primary },
      { environmentId: remote, terminal: running },
    ];

    expect(countRunningTerminalPrograms(threads, primary)).toBe(1);
    expect(countRunningTerminalPrograms(threads, null)).toBe(0);
  });
});

describe("nextAutomaticArm", () => {
  const automaticArm = { at: 1, by: "automatic" } as const;
  const userArm = { at: 1, by: "user" } as const;

  it("arms for a download in automatic mode and keeps a running wait", () => {
    expect(nextAutomaticArm(null, true, true, 5)).toEqual({ at: 5, by: "automatic" });
    expect(nextAutomaticArm(null, true, false, 5)).toBeNull();
    expect(nextAutomaticArm(userArm, true, true, 5)).toBe(userArm);
  });

  it("cancels an automatic wait in manual mode, not a wait that the user chose", () => {
    expect(nextAutomaticArm(automaticArm, false, true, 5)).toBeNull();
    expect(nextAutomaticArm(userArm, false, true, 5)).toBe(userArm);
  });
});
