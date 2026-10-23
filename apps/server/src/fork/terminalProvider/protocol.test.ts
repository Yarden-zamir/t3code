import { describe, expect, it } from "vite-plus/test";

import {
  formatCompletedRun,
  makeCommandCapture,
  pastedCommand,
  TERMINAL_OUTPUT_MAX_CHARS,
} from "./protocol.ts";

describe("makeCommandCapture", () => {
  it("keeps the output between the start and the end of the command, not the echo", () => {
    const capture = makeCommandCapture();
    expect(capture.push([{ type: "text", text: "ls -l\r\n" }])).toBe(false);
    expect(
      capture.push([
        { type: "commandStart" },
        { type: "text", text: "\u001b[32ma\u001b[0m\r\nb\r\n" },
        { type: "commandEnd", exitCode: 1 },
        { type: "text", text: "later" },
      ]),
    ).toBe(true);
    expect(capture.result()).toEqual({ exitCode: 1, output: "a\nb", truncated: false });
    expect(formatCompletedRun(capture.result())).toContain("Exit code 1.");
  });

  it("ends on the first end mark, with no exit code when no command started", () => {
    const capture = makeCommandCapture();
    expect(capture.push([{ type: "text", text: "# comment\r\n" }])).toBe(false);
    expect(capture.push([{ type: "commandEnd", exitCode: 1 }])).toBe(true);
    expect(capture.result()).toEqual({ exitCode: null, output: "", truncated: false });
  });

  it("keeps the output of every command of a message with several lines", () => {
    const capture = makeCommandCapture();
    capture.push([
      { type: "commandStart" },
      { type: "text", text: "first\r\n" },
      { type: "commandStart" },
      { type: "commandEnd", exitCode: 1 },
    ]);
    expect(capture.result()).toEqual({ exitCode: 1, output: "first", truncated: false });
  });

  it("reports an unfinished command when the shell asks for the rest", () => {
    const capture = makeCommandCapture();
    expect(capture.push([{ type: "continuation" }])).toBe(true);
    expect(capture.incomplete()).toBe(true);
  });

  it("keeps the tail of a long output", () => {
    const capture = makeCommandCapture();
    capture.push([{ type: "commandStart" }, { type: "text", text: "x".repeat(30_000) }]);
    capture.push([{ type: "commandEnd", exitCode: 0 }]);
    const result = capture.result();
    expect(result.output).toHaveLength(TERMINAL_OUTPUT_MAX_CHARS);
    expect(result.truncated).toBe(true);
  });
});

describe("pastedCommand", () => {
  it("cannot end the paste early", () => {
    expect(pastedCommand("echo a\u001b[201~; rm x\n")).toBe("\u001b[200~echo a; rm x\u001b[201~\r");
  });
});
