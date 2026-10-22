import { describe, expect, it } from "vite-plus/test";

import { terminalThreadRowStatus, terminalThreadStatusLabel } from "./forkTerminalThreadStatus.ts";

const visited = "2026-10-23T10:00:00.000Z";
const before = "2026-10-23T09:00:00.000Z";
const after = "2026-10-23T11:00:00.000Z";

describe("terminalThreadStatusLabel", () => {
  it("maps session failure and start before attention", () => {
    expect(
      terminalThreadStatusLabel(
        { status: "error", attention: { kind: "bell", at: after } },
        visited,
      ),
    ).toBe("Error");
    expect(terminalThreadStatusLabel({ status: "starting", attention: null }, visited)).toBe(
      "Connecting",
    );
  });

  it("maps unseen attention to a pill and seen attention to none", () => {
    const running = (kind: "bell" | "finished", at: string) =>
      terminalThreadStatusLabel({ status: "running", attention: { kind, at } }, visited);
    expect(running("bell", after)).toBe("Awaiting Input");
    expect(running("finished", after)).toBe("Completed");
    expect(running("bell", before)).toBeNull();
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
  });
});
