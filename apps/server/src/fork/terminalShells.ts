// @effect-diagnostics nodeBuiltinImport:off -- one small synchronous read at server start.
/**
 * Fork: the shells that a terminal thread can run. They are the models of the `terminal`
 * provider, and `terminal.open` takes one by name as `shell`. The driver and the terminal manager
 * read the same list, which `terminalShells` detects once per server process.
 *
 * Limit: a shell that is installed after the server starts shows after a server restart, and a
 * shell whose name is not in TERMINAL_SHELL_NAMES (ksh, tcsh) does not show. Revisit when users
 * ask for either.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

const TERMINAL_SHELL_NAMES = [
  "zsh",
  "bash",
  "fish",
  "sh",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
  "pwsh",
  "powershell",
  "cmd",
] as const;
export type TerminalShellName = (typeof TERMINAL_SHELL_NAMES)[number];

export interface TerminalShell {
  readonly name: TerminalShellName;
  readonly path: string;
}

export interface TerminalShellHost {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** The text of /etc/shells, or null when it cannot be read. */
  readonly etcShells: string | null;
  readonly isExecutable: (path: string) => boolean;
}

function shellName(path: string, platform: NodeJS.Platform): TerminalShellName | undefined {
  const name = (platform === "win32" ? NodePath.win32 : NodePath.posix).parse(path).name;
  return TERMINAL_SHELL_NAMES.find((candidate) => candidate === name.toLowerCase());
}

function windowsShellPaths(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const systemRoot = env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
  const searchPath = env.Path ?? env.PATH ?? "";
  return [
    ...searchPath
      .split(";")
      .filter((directory) => directory.trim().length > 0)
      .map((directory) => NodePath.win32.join(directory.trim(), "pwsh.exe")),
    NodePath.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    env.ComSpec?.trim() || NodePath.win32.join(systemRoot, "System32", "cmd.exe"),
  ];
}

/**
 * One shell for each name, the default shell first: the shell that the terminal manager starts
 * without a `shell`, which is $SHELL on Unix and pwsh on Windows.
 */
export function detectTerminalShells(host: TerminalShellHost): ReadonlyArray<TerminalShell> {
  const userShell = host.env.SHELL?.trim();
  const paths =
    host.platform === "win32"
      ? windowsShellPaths(host.env)
      : [
          ...(userShell ? [userShell] : []),
          ...(host.etcShells ?? "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("/")),
        ];
  const shells: Array<TerminalShell> = [];
  for (const path of paths) {
    const name = shellName(path, host.platform);
    if (name === undefined || shells.some((shell) => shell.name === name)) continue;
    if (host.isExecutable(path)) shells.push({ name, path });
  }
  // Without $SHELL, the terminal manager starts bash.
  const defaultName =
    host.platform === "win32" ? "pwsh" : userShell ? shellName(userShell, host.platform) : "bash";
  const defaultShell = shells.find((shell) => shell.name === defaultName);
  return defaultShell === undefined
    ? shells
    : [defaultShell, ...shells.filter((shell) => shell !== defaultShell)];
}

function isExecutableFile(path: string): boolean {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
}

function readEtcShells(): string | null {
  try {
    return NodeFS.readFileSync("/etc/shells", "utf8");
  } catch {
    return null;
  }
}

let detected: ReadonlyArray<TerminalShell> | undefined;

export const terminalShells = Effect.gen(function* () {
  if (detected !== undefined) return detected;
  const platform = yield* HostProcess.Platform;
  detected = detectTerminalShells({
    platform,
    env: yield* HostProcess.Environment,
    etcShells: platform === "win32" ? null : readEtcShells(),
    isExecutable: isExecutableFile,
  });
  return detected;
});
