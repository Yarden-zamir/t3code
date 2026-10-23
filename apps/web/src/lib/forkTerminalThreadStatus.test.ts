import { describe, expect, it } from "vite-plus/test";

import { terminalThreadRowStatus, terminalThreadStatusLabel } from "./forkTerminalThreadStatus.ts";

const visited = "2026-10-23T10:00:00.000Z";
const before = "2026-10-23T09:00:00.000Z";
const after = "2026-10-23T11:00:00.000Z";

describe("terminalThreadStatusLabel", () => {
  it("maps session failure and start before attention", () => {
    expect(
      terminalThreadStatusLabel(
        { status: "error", attention: { kind: "bell", at: after }, running: false },
        visited,
      ),
    ).toBe("Error");
    expect(
      terminalThreadStatusLabel({ status: "starting", attention: null, running: false }, visited),
    ).toBe("Connecting");
  });

  it("maps unseen attention to a pill and seen attention to none", () => {
    const running = (kind: "bell" | "finished", at: string) =>
      terminalThreadStatusLabel(
        { status: "running", attention: { kind, at }, running: false },
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
        },
        null,
      ),
    ).toBe("Error");
  });

  it("shows a running program as Working, below a bell that asks for input", () => {
    const state = (running: boolean, kind: "bell" | "finished") =>
      terminalThreadStatusLabel(
        { status: "running", attention: { kind, at: after, exitCode: 1 }, running },
        visited,
      );
    expect(state(true, "finished")).toBe("Working");
    expect(state(true, "bell")).toBe("Awaiting Input");
    expect(state(false, "finished")).toBe("Error");
  });

  it("shows nothing for a thread without terminal state", () => {
    expect(terminalThreadStatusLabel(undefined, visited)).toBeNull();
  });
});

describe("terminalThreadRowStatus", () => {
  it("fills in an idle row and leaves a message run alone", () => {
    expect(terminalThreadRowStatus("ready", "Awaiting Input")).toBe("input");
    expect(terminalThreadRowStatus("waiting", "Error")).toBe("failed");
    expect(terminalThreadRowStatus("working", "Awaiting Input")).toBe("working");
    expect(terminalThreadRowStatus("ready", "Completed")).toBe("ready");
    expect(terminalThreadRowStatus("ready", "Working")).toBe("working");
  });
});
