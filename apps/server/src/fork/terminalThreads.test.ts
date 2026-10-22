import { describe, expect, it } from "vite-plus/test";

import { detectTerminalAttention } from "./terminalThreads.ts";

describe("detectTerminalAttention", () => {
  it("detects a bell and an app notification", () => {
    expect(detectTerminalAttention("done\u0007")).toBe(true);
    expect(detectTerminalAttention("\u001b]9;Build finished\u001b\\")).toBe(true);
    expect(detectTerminalAttention("\u001b]777;notify;Title;Body\u0007")).toBe(true);
  });

  it("ignores the bell that ends a title sequence and progress reports", () => {
    expect(detectTerminalAttention("\u001b]0;~/project\u0007prompt $ ")).toBe(false);
    expect(detectTerminalAttention("\u001b]9;4;1;50\u001b\\")).toBe(false);
    expect(detectTerminalAttention("\u001b]9;9;/home/user\u001b\\")).toBe(false);
    expect(detectTerminalAttention("plain output")).toBe(false);
  });

  it("finds a bell after a title sequence in the same chunk", () => {
    expect(detectTerminalAttention("\u001b]0;title\u0007output\u0007")).toBe(true);
  });
});
