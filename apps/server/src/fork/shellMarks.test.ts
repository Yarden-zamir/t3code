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

  it("reads an end mark without an exit code", () => {
    const parser = makeShellMarkParser();
    expect(parser.push("\u001b]133;D\u0007")).toEqual([{ type: "commandEnd", exitCode: null }]);
  });
});
