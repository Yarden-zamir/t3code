// @effect-diagnostics nodeBuiltinImport:off -- one small synchronous read at server start.
/**
 * Fork: the shells of a terminal thread: the models of the `terminal` provider, which
 * `terminal.open` takes by name as `shell`. `terminalShells` detects them once per server process,
 * plus custom shells from the provider settings. Limit: a newly installed shell shows after a
 * restart, and a name outside TERMINAL_SHELL_NAMES needs a custom shell. Revisit when users ask.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type ServerSettings,
  TERMINAL_SHELL_NAMES,
  TERMINAL_THREAD_INSTANCE_ID,
  type TerminalCustomShell,
  TerminalCustomShells,
  type TerminalShellName,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ShellCandidate } from "../terminal/Manager.ts";

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
  const localPrograms = env.LOCALAPPDATA?.trim()
    ? NodePath.win32.join(env.LOCALAPPDATA.trim(), "Programs")
    : undefined;
  // Git Bash only from the Git install folders: the bash.exe on the PATH is often the WSL
  // launcher in System32, which is another system. Limit: a Git in another folder (scoop) does
  // not show; revisit when a user asks.
  const gitBashPaths = [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"], localPrograms]
    .map((directory) => directory?.trim() ?? "")
    .filter((directory) => directory.length > 0)
    .map((directory) => NodePath.win32.join(directory, "Git", "bin", "bash.exe"));
  return [
    ...searchPath
      .split(";")
      .filter((directory) => directory.trim().length > 0)
      .map((directory) => NodePath.win32.join(directory.trim(), "pwsh.exe")),
    NodePath.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    env.ComSpec?.trim() || NodePath.win32.join(systemRoot, "System32", "cmd.exe"),
    ...gitBashPaths,
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

/** The part of the `terminal` provider settings that the terminal manager reads too. */
export const TerminalShellSettings = Schema.Struct({
  customShells: TerminalCustomShells.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
const decodeTerminalShellSettings = Schema.decodeUnknownOption(TerminalShellSettings);

/**
 * The custom shells in the settings. An invalid config gives none: the provider shows the decode
 * error, and `terminal.open` fails with the shell as unknown.
 */
export function terminalCustomShellsOf(
  settings: Pick<ServerSettings, "providerInstances">,
): ReadonlyArray<TerminalCustomShell> {
  const config = settings.providerInstances[TERMINAL_THREAD_INSTANCE_ID]?.config ?? {};
  return Option.match(decodeTerminalShellSettings(config), {
    onNone: () => [],
    onSome: (decoded) => decoded.customShells,
  });
}

export class TerminalCustomShellNotFoundError extends Schema.TaggedError<TerminalCustomShellNotFoundError>()(
  "TerminalCustomShellNotFoundError",
  { shell: Schema.String, executable: Schema.String },
) {
  override get message(): string {
    return `The shell "${this.shell}" cannot start: "${this.executable}" is not an executable file, and not on the PATH of the terminal.`;
  }
}

/**
 * The command of a custom shell. The executable resolves before the spawn, on the PATH of the
 * terminal and with PATHEXT on Windows, so a missing one fails with its name and not as a dead
 * terminal. A relative path starts at the folder of the terminal.
 */
export const customShellCandidate = Effect.fn("terminalShells.customShellCandidate")(function* (
  shell: TerminalCustomShell,
  input: {
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
  },
) {
  const path = input.platform === "win32" ? NodePath.win32 : NodePath.posix;
  const resolve = yield* SpawnExecutableResolution;
  const isPath = shell.executable.includes("/") || shell.executable.includes("\\");
  const resolved = resolve(
    isPath ? path.resolve(input.cwd, shell.executable) : shell.executable,
    input.platform,
    input.env,
  );
  if (resolved === undefined) {
    return yield* new TerminalCustomShellNotFoundError({
      shell: shell.name,
      executable: shell.executable,
    });
  }
  const extension = path.extname(resolved).toLowerCase();
  if (input.platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
    // A batch file runs only inside cmd.exe. Limit: cmd.exe parses the line again, so an argument
    // with a quote or one of & | < > ^ breaks. Revisit when a custom shell needs one.
    return {
      shell: input.env.ComSpec?.trim() || "cmd.exe",
      args: ["/d", "/c", resolved, ...shell.args],
    } satisfies ShellCandidate;
  }
  return { shell: resolved, args: [...shell.args] } satisfies ShellCandidate;
});

/**
 * Why a custom shell cannot start on this server, or undefined when its executable is found. The
 * provider lists it with the shell, so Settings shows it for a remote server too. Limit: it checks
 * the server PATH, not the terminal PATH with the managed agent folders, and no relative path,
 * which starts at each terminal folder. Revisit when a custom shell runs from either.
 */
export function customShellProblem(
  shell: TerminalCustomShell,
  input: { readonly platform: NodeJS.Platform; readonly env: NodeJS.ProcessEnv },
): Effect.Effect<string | undefined> {
  const path = input.platform === "win32" ? NodePath.win32 : NodePath.posix;
  const isPath = shell.executable.includes("/") || shell.executable.includes("\\");
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
  if (isPath && !path.isAbsolute(shell.executable)) return Effect.succeed(undefined);
  return customShellCandidate(shell, { ...input, cwd: path.sep }).pipe(
    Effect.match({ onFailure: (error) => error.message, onSuccess: () => undefined }),
  );
}
