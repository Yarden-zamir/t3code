import { describe, expect, it } from "vite-plus/test";

import {
  applyShellItems,
  forgetUnconfirmedShellState,
  type ShellStateHolder,
  UNCONFIRMED_SHELL_STATE_MS,
} from "./terminalShellState.ts";

const fresh = (): ShellStateHolder => ({
  shell: "starting",
  shellConfirmedAt: 0,
  attention: null,
  hasRunningSubprocess: false,
  command: null,
});
const t0 = "2026-10-23T10:00:00.000Z";
const t1 = "2026-10-23T10:00:05.000Z";

describe("applyShellItems", () => {
  it("follows a command from prompt to running to finished with its exit code", () => {
    const session = fresh();
    expect(applyShellItems(session, [{ type: "prompt" }], t0)).toBe(true);
    expect(session).toMatchObject({ shell: "prompt", hasRunningSubprocess: false });

    applyShellItems(session, [{ type: "commandStart", commandLine: null }], t0);
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

describe("forgetUnconfirmedShellState", () => {
  it("forgets a running state that no child process confirms for long enough", () => {
    const session = fresh();
    applyShellItems(session, [{ type: "commandStart", commandLine: null }], t0);
    const startedAt = Date.parse(t0);
    expect(forgetUnconfirmedShellState(session, false, startedAt + 1_000)).toBe(false);
    // A child process confirms the state and starts the wait again.
    const confirmedAt = startedAt + UNCONFIRMED_SHELL_STATE_MS;
    expect(forgetUnconfirmedShellState(session, true, confirmedAt)).toBe(false);
    expect(forgetUnconfirmedShellState(session, false, confirmedAt + 1_000)).toBe(false);
    expect(
      forgetUnconfirmedShellState(session, false, confirmedAt + UNCONFIRMED_SHELL_STATE_MS),
    ).toBe(true);
    expect(session).toMatchObject({ shell: null, hasRunningSubprocess: false });
  });

  it("keeps a prompt state", () => {
    const session = fresh();
    applyShellItems(session, [{ type: "prompt" }], t0);
    expect(forgetUnconfirmedShellState(session, false, Date.parse(t1) + 60_000)).toBe(false);
  });
});
