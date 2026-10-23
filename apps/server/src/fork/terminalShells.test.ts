import { describe, expect, it } from "vite-plus/test";

import { detectTerminalShells } from "./terminalShells.ts";

const etcShells = ["# List of shells", "/bin/bash", "/bin/zsh", "/bin/csh", "/bin/sh", ""].join(
  "\n",
);

describe("detectTerminalShells", () => {
  it("lists one executable shell per name, $SHELL first with its own path", () => {
    expect(
      detectTerminalShells({
        platform: "darwin",
        env: { SHELL: "/opt/homebrew/bin/zsh" },
        etcShells,
        isExecutable: (path) => path !== "/bin/sh",
      }),
    ).toEqual([
      { name: "zsh", path: "/opt/homebrew/bin/zsh" },
      { name: "bash", path: "/bin/bash" },
    ]);
  });

  it("puts bash first without $SHELL, like the terminal manager", () => {
    expect(
      detectTerminalShells({
        platform: "linux",
        env: {},
        etcShells: "/bin/sh\n/usr/bin/zsh\n/bin/bash\n",
        isExecutable: () => true,
      }).map((shell) => shell.name),
    ).toEqual(["bash", "sh", "zsh"]);
  });

  it("finds pwsh on the Windows path before Windows PowerShell and cmd", () => {
    expect(
      detectTerminalShells({
        platform: "win32",
        env: { Path: "C:\\Tools;C:\\Program Files\\PowerShell\\7", SystemRoot: "C:\\Windows" },
        etcShells: null,
        isExecutable: (path) => path !== "C:\\Tools\\pwsh.exe",
      }),
    ).toEqual([
      { name: "pwsh", path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
      {
        name: "powershell",
        path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      },
      { name: "cmd", path: "C:\\Windows\\System32\\cmd.exe" },
    ]);
  });
});
