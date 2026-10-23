import { describe, expect, it } from "vite-plus/test";

import { applyShellItems, type ShellStateHolder } from "./terminalShellState.ts";

const fresh = (): ShellStateHolder => ({
  shell: null,
  attention: null,
  hasRunningSubprocess: false,
});
const t0 = "2026-10-23T10:00:00.000Z";
const t1 = "2026-10-23T10:00:05.000Z";

describe("applyShellItems", () => {
  it("follows a command from prompt to running to finished with its exit code", () => {
    const session = fresh();
    expect(applyShellItems(session, [{ type: "prompt" }], t0)).toBe(true);
    expect(session).toMatchObject({ shell: "prompt", hasRunningSubprocess: false });

    applyShellItems(session, [{ type: "commandStart" }], t0);
    expect(session).toMatchObject({ shell: "running", hasRunningSubprocess: true });

    applyShellItems(session, [{ type: "commandEnd", exitCode: 2 }, { type: "prompt" }], t1);
    expect(session).toMatchObject({
      shell: "prompt",
      hasRunningSubprocess: false,
      attention: { kind: "finished", at: t1, exitCode: 2 },
    });
  });

  it("does not report a finished command for the first prompt of the shell", () => {
    const session = fresh();
    applyShellItems(session, [{ type: "commandEnd", exitCode: 0 }, { type: "prompt" }], t0);
    expect(session.attention).toBeNull();
    expect(session.shell).toBe("prompt");
  });

  it("raises a bell once per second", () => {
    const session = fresh();
    expect(applyShellItems(session, [{ type: "attention" }], t0)).toBe(true);
    expect(applyShellItems(session, [{ type: "attention" }], "2026-10-23T10:00:00.400Z")).toBe(
      false,
    );
    expect(applyShellItems(session, [{ type: "attention" }], t1)).toBe(true);
  });
});
