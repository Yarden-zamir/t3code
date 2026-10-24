import type { TerminalSummary } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { attentionTransition, newTerminalAttentions, terminalAttentionTitle } from "./WebPush.ts";

describe("attentionTransition", () => {
  it("notifies when a thread starts to wait or a running thread ends", () => {
    expect(attentionTransition("running", "waiting_for_approval")).toBe("waiting_for_approval");
    expect(attentionTransition("running", "waiting_for_input")).toBe("waiting_for_input");
    expect(attentionTransition("running", "completed")).toBe("completed");
    expect(attentionTransition("waiting_for_input", "failed")).toBe("failed");
  });

  it("stays quiet for a thread first seen since the start, and for a new session", () => {
    expect(attentionTransition(undefined, "waiting_for_input")).toBeNull();
    expect(attentionTransition(undefined, "completed")).toBeNull();
    // A new session reads `completed` for an instant before its first turn.
    expect(attentionTransition(null, "completed")).toBeNull();
    expect(attentionTransition("completed", "completed")).toBeNull();
  });

  it("stays quiet when a silent run completes, but not when it fails", () => {
    expect(attentionTransition("running", "completed", true)).toBeNull();
    expect(attentionTransition("running", "failed", true)).toBe("failed");
  });
});

describe("terminal attention", () => {
  const terminal = (
    terminalId: string,
    attention: TerminalSummary["attention"],
  ): TerminalSummary => ({
    threadId: "thread-1",
    terminalId,
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 100,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: "zsh",
    updatedAt: "2026-10-23T00:00:00.000Z",
    ...(attention === undefined ? {} : { attention }),
  });
  const bell = { kind: "bell", at: "2026-10-23T00:00:01.000Z" } as const;

  it("notifies once for each new attention of a main terminal", () => {
    const started = newTerminalAttentions(new Map(), {
      type: "snapshot",
      terminals: [terminal("term-1", bell)],
    });
    expect(started.fresh).toEqual([]);

    const repeated = newTerminalAttentions(started.seen, {
      type: "upsert",
      terminal: terminal("term-1", bell),
    });
    expect(repeated.fresh).toEqual([]);

    const finished = { kind: "finished", at: "2026-10-23T00:00:02.000Z", exitCode: 1 } as const;
    const next = newTerminalAttentions(repeated.seen, {
      type: "upsert",
      terminal: terminal("term-1", finished),
    });
    expect(next.fresh).toEqual([{ threadId: "thread-1", attention: finished }]);

    const drawer = newTerminalAttentions(next.seen, {
      type: "upsert",
      terminal: terminal("term-2", { ...bell, at: "2026-10-23T00:00:03.000Z" }),
    });
    expect(drawer.fresh).toEqual([]);
  });

  it("names a bell, a program that ends and a program that fails", () => {
    expect(terminalAttentionTitle(bell)).toBe("Input needed");
    expect(terminalAttentionTitle({ kind: "finished", at: bell.at, exitCode: 0 })).toBe(
      "Program done",
    );
    expect(terminalAttentionTitle({ kind: "finished", at: bell.at, exitCode: null })).toBe(
      "Program done",
    );
    expect(terminalAttentionTitle({ kind: "finished", at: bell.at, exitCode: 2 })).toBe(
      "Program failed",
    );
  });
});
