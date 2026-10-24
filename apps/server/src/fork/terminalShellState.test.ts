import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  applyShellItems,
  forgetUnconfirmedShellState,
  NOTIFIED_COMMAND_MIN_MS,
  type ShellStateHolder,
  UNCONFIRMED_SHELL_STATE_MS,
} from "./terminalShellState.ts";

const fresh = (): ShellStateHolder => ({
  shell: "starting",
  shellConfirmedAt: 0,
  attention: null,
  hasRunningSubprocess: false,
  command: null,
  commandStartedAt: 0,
});
const t0 = "2026-10-23T10:00:00.000Z";
const t1 = "2026-10-23T10:00:05.000Z";
const after = (at: string, ms: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(at) + ms));
/** The first moment at which a command that started at t0 counts as long. */
const tLong = after(t0, NOTIFIED_COMMAND_MIN_MS);

describe("applyShellItems", () => {
  it("follows a long command from prompt to running to finished with its exit code", () => {
    const session = fresh();
    expect(applyShellItems(session, [{ type: "prompt" }], t0)).toBe(true);
    expect(session).toMatchObject({ shell: "prompt", hasRunningSubprocess: false });

    applyShellItems(session, [{ type: "commandStart", commandLine: null }], t0);
    expect(session).toMatchObject({ shell: "running", hasRunningSubprocess: true });

    applyShellItems(session, [{ type: "commandEnd", exitCode: 2 }, { type: "prompt" }], tLong);
    expect(session).toMatchObject({
      shell: "prompt",
      hasRunningSubprocess: false,
      attention: { kind: "finished", at: tLong, exitCode: 2 },
    });
  });

  it("raises no attention for a short command, also a failed one", () => {
    const session = fresh();
    applyShellItems(session, [{ type: "prompt" }, { type: "commandStart", commandLine: "ls" }], t0);
    expect(
      applyShellItems(session, [{ type: "commandEnd", exitCode: 127 }, { type: "prompt" }], t1),
    ).toBe(true);
    expect(session).toMatchObject({ shell: "prompt", attention: null });
  });

  it("raises no attention for a bell at the prompt, such as a completion beep", () => {
    const session = fresh();
    applyShellItems(session, [{ type: "prompt" }], t0);
    expect(applyShellItems(session, [{ type: "attention" }], t1)).toBe(false);
    expect(applyShellItems(session, [{ type: "continuation" }, { type: "attention" }], t1)).toBe(
      false,
    );
    expect(session.attention).toBeNull();
  });

  it("keeps only the program and subcommand of a command line", () => {
    const session = fresh();
    applyShellItems(
      session,
      [{ type: "commandStart", commandLine: "GITHUB_TOKEN=ghp_abc123 gh pr list --limit 5" }],
      t0,
    );
    expect(session.command).toBe("gh pr list");
  });

  it("does not report a finished command for the first prompt of the shell", () => {
    const session = fresh();
    applyShellItems(session, [{ type: "commandEnd", exitCode: 0 }, { type: "prompt" }], t0);
    expect(session.attention).toBeNull();
    expect(session.shell).toBe("prompt");
  });

  it("keeps the bell of a program in its end, so a client can still show the bell", () => {
    const session = fresh();
    applyShellItems(session, [{ type: "prompt" }, { type: "commandStart", commandLine: null }], t0);
    applyShellItems(session, [{ type: "attention" }], t0);
    applyShellItems(session, [{ type: "commandEnd", exitCode: 0 }, { type: "prompt" }], tLong);
    expect(session.attention).toEqual({ kind: "finished", at: tLong, exitCode: 0, bellAt: t0 });

    const t2 = after(tLong, NOTIFIED_COMMAND_MIN_MS);
    applyShellItems(session, [{ type: "commandStart", commandLine: null }], tLong);
    applyShellItems(session, [{ type: "commandEnd", exitCode: 1 }, { type: "prompt" }], t2);
    expect(session.attention).toEqual({ kind: "finished", at: t2, exitCode: 1, bellAt: t0 });
  });

  it("raises a bell once per second", () => {
    const session = fresh();
    applyShellItems(session, [{ type: "commandStart", commandLine: null }], t0);
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
