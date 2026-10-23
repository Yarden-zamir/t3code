import { describe, expect, it } from "vite-plus/test";

import { makeShellMarkParser, type ShellItem } from "./shellMarks.ts";

const prompt = "\u001b]133;A\u0007";
const start = "\u001b]133;C\u0007";
const end = (code: number) => `\u001b]133;D;${code}\u0007`;

const kinds = (items: ReadonlyArray<ShellItem>) => items.map((item) => item.type);
const textOf = (items: ReadonlyArray<ShellItem>) =>
  items.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("");

describe("makeShellMarkParser", () => {
  it("reads a command from start to end and keeps its output as text", () => {
    const parser = makeShellMarkParser();
    const items = parser.push(`${prompt}ls\r\n${start}a\r\nb\r\n${end(3)}${prompt}`);
    expect(kinds(items)).toEqual([
      "prompt",
      "text",
      "commandStart",
      "text",
      "commandEnd",
      "prompt",
    ]);
    expect(items.find((item) => item.type === "commandEnd")).toEqual({
      type: "commandEnd",
      exitCode: 3,
    });
    expect(textOf(items)).toBe("ls\r\na\r\nb\r\n");
  });

  it("reads the command line of a start mark", () => {
    const parser = makeShellMarkParser();
    const items = parser.push(`${prompt}\u001b]133;C;cmdline=git commit -m "a;b"\u0007out`);
    expect(items).toEqual([
      { type: "prompt" },
      { type: "commandStart", commandLine: 'git commit -m "a;b"' },
      { type: "text", text: "out" },
    ]);
  });

  it("joins a mark that arrives in two chunks", () => {
    const parser = makeShellMarkParser();
    const first = parser.push("out\u001b]133;D;");
    const second = parser.push(`7\u0007next`);
    expect(textOf(first)).toBe("out");
    expect(second).toEqual([
      { type: "commandEnd", exitCode: 7 },
      { type: "text", text: "next" },
    ]);
    expect(kinds(parser.push("a\u001b"))).toEqual(["text"]);
    expect(kinds(parser.push("]133;A\u0007"))).toEqual(["prompt"]);
  });

  it("reports a bell and an app notification but not the bell that ends a title", () => {
    const parser = makeShellMarkParser();
    expect(kinds(parser.push("done\u0007"))).toEqual(["text", "attention"]);
    expect(kinds(parser.push("\u001b]9;Build finished\u001b\\"))).toEqual(["attention"]);
    expect(kinds(parser.push("\u001b]777;notify;Title;Body\u0007"))).toEqual(["attention"]);
    expect(kinds(parser.push("\u001b]0;~/project\u0007$ "))).toEqual(["text"]);
    expect(kinds(parser.push("\u001b]9;4;1;50\u001b\\"))).toEqual(["text"]);
    expect(kinds(parser.push("\u001b]9;9;/home/user\u001b\\"))).toEqual(["text"]);
  });

  it("reads the continuation prompt mark", () => {
    const parser = makeShellMarkParser();
    expect(parser.push("\u001b]133;A;k=s\u0007")).toEqual([{ type: "continuation" }]);
  });

  it("drops a sequence too long to hold, so its end is no bell", () => {
    const parser = makeShellMarkParser();
    expect(textOf(parser.push(`before\u001b]1337;File=${"x".repeat(5_000)}`))).toBe("before");
    expect(parser.push("y".repeat(3_000))).toEqual([]);
    expect(parser.push("z\u0007after")).toEqual([{ type: "text", text: "after" }]);
  });

  it("keeps the marks after a sequence that a program cut off", () => {
    const parser = makeShellMarkParser();
    parser.push(`\u001b]1337;File=${"x".repeat(5_000)}`);
    expect(kinds(parser.push("^C\r\n\u001b]133;D;130\u0007\u001b]133;A\u0007$ "))).toEqual([
      "commandEnd",
      "prompt",
      "text",
    ]);
    const short = makeShellMarkParser();
    expect(kinds(short.push("\u001b]1337;File=abc\u001b]133;D;1\u0007"))).toEqual([
      "text",
      "commandEnd",
    ]);
  });

  it("reads an end mark without an exit code", () => {
    const parser = makeShellMarkParser();
    expect(parser.push("\u001b]133;D\u0007")).toEqual([{ type: "commandEnd", exitCode: null }]);
  });
});
