import { TERMINAL_THREAD_INSTANCE_ID, TerminalCustomShells } from "@t3tools/contracts";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, it } from "@effect/vitest";
import { expect } from "vite-plus/test";

import {
  customShellCandidate,
  detectTerminalShells,
  terminalCustomShellsOf,
} from "./terminalShells.ts";

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
      { name: "csh", path: "/bin/csh" },
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

describe("detectTerminalShells on Windows", () => {
  it("finds Git Bash in the Git install folder, not the WSL bash on the PATH", () => {
    const shells = detectTerminalShells({
      platform: "win32",
      env: {
        Path: "C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
        ProgramFiles: "C:\\Program Files",
      },
      etcShells: null,
      isExecutable: (path) =>
        path === "C:\\Windows\\System32\\cmd.exe" ||
        path === "C:\\Windows\\System32\\bash.exe" ||
        path === "C:\\Program Files\\Git\\bin\\bash.exe",
    });
    expect(shells).toEqual([
      { name: "cmd", path: "C:\\Windows\\System32\\cmd.exe" },
      { name: "bash", path: "C:\\Program Files\\Git\\bin\\bash.exe" },
    ]);
  });
});

describe("customShellCandidate", () => {
  const python = { name: "python", executable: "uv", args: ["run", "python"] };
  const run = (
    shell: typeof python,
    input: Parameters<typeof customShellCandidate>[1],
    resolve: (command: string) => string | undefined,
  ) =>
    customShellCandidate(shell, input).pipe(
      Effect.provideService(SpawnExecutableResolution, resolve),
      Effect.result,
    );

  it.effect("runs the executable from the PATH with its arguments", () =>
    Effect.gen(function* () {
      const result = yield* run(python, { platform: "darwin", env: {}, cwd: "/work" }, (command) =>
        command === "uv" ? "/opt/bin/uv" : undefined,
      );
      expect(result).toMatchObject({
        _tag: "Success",
        success: { shell: "/opt/bin/uv", args: ["run", "python"] },
      });
    }),
  );

  it.effect("starts a relative path in the folder of the terminal", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      yield* run(
        { ...python, executable: "./bin/repl" },
        { platform: "linux", env: {}, cwd: "/work" },
        (command) => {
          seen.push(command);
          return command;
        },
      );
      expect(seen).toEqual(["/work/bin/repl"]);
    }),
  );

  it.effect("runs a Windows batch file through cmd.exe", () =>
    Effect.gen(function* () {
      const result = yield* run(
        python,
        { platform: "win32", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, cwd: "C:\\work" },
        () => "C:\\Users\\me\\.local\\bin\\uv.CMD",
      );
      expect(result).toMatchObject({
        _tag: "Success",
        success: {
          shell: "C:\\Windows\\System32\\cmd.exe",
          args: ["/d", "/c", "C:\\Users\\me\\.local\\bin\\uv.CMD", "run", "python"],
        },
      });
    }),
  );

  it.effect("fails with the shell and executable names when nothing resolves", () =>
    Effect.gen(function* () {
      const result = yield* run(
        python,
        { platform: "win32", env: {}, cwd: "C:\\work" },
        () => undefined,
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "TerminalCustomShellNotFoundError", shell: "python", executable: "uv" },
      });
    }),
  );
});

describe("custom shell settings", () => {
  const decode = Schema.decodeUnknownResult(TerminalCustomShells);

  it("refuses a detected shell name, also one that is not installed, and duplicates", () => {
    expect(decode([{ name: "PWSH", executable: "x", args: [] }])._tag).toBe("Failure");
    expect(decode([{ name: "terminal", executable: "x", args: [] }])._tag).toBe("Failure");
    expect(
      decode([
        { name: "py", executable: "x", args: [] },
        { name: "py", executable: "y", args: [] },
      ])._tag,
    ).toBe("Failure");
    expect(decode([{ name: " py ", executable: "uv", args: ["run"] }])).toMatchObject({
      _tag: "Success",
      success: [{ name: "py", executable: "uv", args: ["run"] }],
    });
  });

  it("reads the custom shells of the terminal provider, and none from an invalid config", () => {
    const settingsWith = (config: unknown) => ({
      providerInstances: { [TERMINAL_THREAD_INSTANCE_ID]: { driver: "terminal", config } },
    });
    const shell = { name: "py", executable: "uv", args: [] };
    expect(terminalCustomShellsOf(settingsWith({ customShells: [shell] }) as never)).toEqual([
      shell,
    ]);
    expect(
      terminalCustomShellsOf(settingsWith({ customShells: [{ name: "zsh" }] }) as never),
    ).toEqual([]);
    expect(terminalCustomShellsOf({ providerInstances: {} })).toEqual([]);
  });
});
