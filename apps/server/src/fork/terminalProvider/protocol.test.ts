import { describe, expect, it } from "vite-plus/test";

import { wrapCommandForCompletion } from "../../project/ProjectSetupScriptRunner.ts";
import {
  completionSentinel,
  formatCompletedRun,
  makeCompletionCollector,
  TERMINAL_OUTPUT_MAX_CHARS,
} from "./protocol.ts";

const sentinel = completionSentinel("abc123");
const wrapped = wrapCommandForCompletion("echo hi", "posix", sentinel);
const echoedWrapperLines = wrapped.split("\r").filter((line) => line.length > 0);

describe("makeCompletionCollector", () => {
  it("reads the exit code and the output, and skips the echoed wrapper", () => {
    const collector = makeCompletionCollector({ sentinel, echoedWrapperLines });
    // The shell echoes the typed wrapper, runs it, then prints the marker on its own line.
    expect(collector.push(`$ ${wrapped.split("\r").join("\r\n")}\r\n`)).toBe(false);
    expect(collector.push("hi\r\n\u001b[1mbold\u001b[0m\r\n")).toBe(false);
    expect(collector.push(`\r\n${sentinel}3\r\n`)).toBe(true);
    expect(collector.result()).toEqual({ exitCode: 3, output: "hi\nbold", truncated: false });
  });

  it("finds a marker that arrives in pieces", () => {
    const collector = makeCompletionCollector({ sentinel, echoedWrapperLines });
    expect(collector.push(`out\r\n${sentinel.slice(0, 10)}`)).toBe(false);
    expect(collector.push(`${sentinel.slice(10)}0\r\n`)).toBe(true);
    expect(collector.result().exitCode).toBe(0);
  });

  it("keeps the last lines of a long output", () => {
    const collector = makeCompletionCollector({ sentinel, echoedWrapperLines });
    collector.push(`${"x".repeat(TERMINAL_OUTPUT_MAX_CHARS)}\r\ntail\r\n`);
    const result = collector.result();
    expect(result.truncated).toBe(true);
    expect(result.output.endsWith("tail")).toBe(true);
  });
});

describe("formatCompletedRun", () => {
  it("says when the terminal ended without a marker", () => {
    expect(formatCompletedRun({ exitCode: null, output: "", truncated: false })).toContain(
      "ended before",
    );
  });
});
