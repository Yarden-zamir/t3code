import { describe, expect, it } from "vite-plus/test";

import { terminalThreadTitle } from "./forkTerminalThreads.ts";

describe("terminalThreadTitle", () => {
  it("names a thread after its command line first", () => {
    expect(terminalThreadTitle({ command: " sleep 700 ", program: "sleep", shell: "zsh" })).toBe(
      "sleep 700",
    );
  });

  it("names a thread without a command line after the running program", () => {
    expect(terminalThreadTitle({ command: undefined, program: "vim", shell: "zsh" })).toBe("vim");
  });

  it("names a custom shell that reports no command after the shell", () => {
    expect(terminalThreadTitle({ command: "  ", shell: "python" })).toBe("python");
  });

  it("names the default shell with nothing known Terminal", () => {
    expect(terminalThreadTitle({ command: undefined, shell: undefined })).toBe("Terminal");
  });

  it("keeps a long command line to the title limit", () => {
    expect(terminalThreadTitle({ command: "x".repeat(300), shell: undefined })).toHaveLength(80);
  });
});
