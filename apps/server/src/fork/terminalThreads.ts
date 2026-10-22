// @effect-diagnostics nodeBuiltinImport:off -- the tmux socket name comes from the state folder.
/**
 * Fork: the tmux launch of terminal threads (`forkTerminalThreads.ts` in contracts), behind the
 * server setting `terminalThreadsTmux`. The main terminal of a terminal thread runs
 * `tmux new-session -A` instead of a shell. The tmux server is
 * not a child of T3, so the session and its apps outlive a T3 restart, and the next open attaches
 * to the same session.
 *
 * Each T3 state folder has its own tmux socket and config, so a dev server never attaches to the
 * sessions of the live server, and the user's `~/.tmux.conf` does not apply.
 *
 * Limit: a session stays after its thread is deleted. Revisit when unused sessions pile up; until
 * then `tmux -L <socket> kill-session -t t3-<threadId>` removes one.
 */
import * as NodeCrypto from "node:crypto";

import {
  DEFAULT_TERMINAL_ID,
  TERMINAL_THREAD_ENV,
  TERMINAL_THREAD_FIND_SEQUENCE,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { ShellCandidate } from "../terminal/Manager.ts";
import { T3_TERMINAL_THREAD_ID_ENV } from "../terminal/terminalEnv.ts";

export interface TerminalLaunch {
  readonly shell: ShellCandidate;
  /** Delivers bytes to the app in the terminal unchanged, past the multiplexer's key parser. */
  readonly passthroughWrite: (data: string) => Effect.Effect<void>;
  /**
   * The process whose children are the programs that run in the terminal. The terminal process
   * is the tmux client, which has no children: the shell runs under the detached tmux server.
   * Null when the pane is not known yet.
   */
  readonly shellPid: Effect.Effect<number | null>;
}

export interface TerminalLaunchInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly runtimeEnv: Readonly<Record<string, string>> | null;
  readonly spawnEnv: NodeJS.ProcessEnv;
}

/**
 * No status line and no prefix key, so every key reaches the app. Mouse mode lets the wheel
 * scroll the tmux history. The user key opens an incremental search of that history. Extended
 * keys let Ctrl and Shift arrows through. A key that must reach the app unchanged uses
 * `passthroughWrite` below: tmux reads the Command key as Meta and cannot carry the Kitty
 * keyboard protocol.
 */
export const terminalThreadTmuxConfig = (historyLines: number) =>
  [
    "set -g extended-keys on",
    "set -g status off",
    "set -g prefix None",
    "set -g prefix2 None",
    "set -g mouse on",
    `set -g history-limit ${historyLines}`,
    'set -g default-terminal "xterm-256color"',
    "set -g set-clipboard on",
    "set -g allow-passthrough on",
    "set -g bell-action any",
    "set -g visual-bell off",
    "set -g focus-events on",
    "set -g window-size latest",
    "set -s escape-time 0",
    `set -s user-keys[0] "${TERMINAL_THREAD_FIND_SEQUENCE.replace("\u001b", "\\e")}"`,
    'bind -n User0 copy-mode \\; command-prompt -i -I "#{pane_search_string}" -T search -p "(find)" { send -X search-backward-incremental "%%" }',
    "",
  ].join("\n");

/** The main terminal of a terminal thread is the thread's view. */
export function isTerminalThreadMainTerminal(
  terminalId: string,
  runtimeEnv: Readonly<Record<string, string>> | null,
): boolean {
  return terminalId === DEFAULT_TERMINAL_ID && runtimeEnv?.[TERMINAL_THREAD_ENV] === "1";
}

const BELL = "\u0007";
const OSC_START = "\u001b]";
const STRING_TERMINATOR = "\u001b\\";

// OSC 9;4 is a progress report and OSC 9;9 a working directory report, not notifications.
function isNotificationOsc(body: string): boolean {
  return (
    (body.startsWith("9;") && !body.startsWith("9;4;") && !body.startsWith("9;9;")) ||
    body.startsWith("777;notify;") ||
    body.startsWith("99;")
  );
}

/**
 * True when a chunk of terminal output rings the bell or sends an app notification. A bell that
 * ends an OSC sequence (a window title) does not count.
 *
 * Limit: a notification split across two chunks is missed. Revisit if a program is seen to lose
 * its notification; the fix is to carry the unfinished sequence in the session.
 */
export function detectTerminalAttention(data: string): boolean {
  let index = 0;
  while (index < data.length) {
    const bell = data.indexOf(BELL, index);
    const osc = data.indexOf(OSC_START, index);
    if (bell !== -1 && (osc === -1 || bell < osc)) return true;
    if (osc === -1) return false;
    const bodyStart = osc + OSC_START.length;
    const bellEnd = data.indexOf(BELL, bodyStart);
    const stEnd = data.indexOf(STRING_TERMINATOR, bodyStart);
    const end = bellEnd === -1 ? stEnd : stEnd === -1 ? bellEnd : Math.min(bellEnd, stEnd);
    if (end === -1) return false;
    if (isNotificationOsc(data.slice(bodyStart, end))) return true;
    index = end + (end === bellEnd ? BELL.length : STRING_TERMINATOR.length);
  }
  return false;
}

export function terminalThreadTmuxSocket(stateDir: string): string {
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  return `t3code-${hash}`;
}

// tmux reads ":" and "." in a target as the window and pane separators, so the name avoids them.
// An agent thread id such as "mcp:<uuid>" has a colon.
export function terminalThreadTmuxSession(threadId: string): string {
  return `t3-${threadId.replaceAll(":", "_").replaceAll(".", "_")}`;
}

export const makeTerminalThreadLaunch = Effect.fn("makeTerminalThreadLaunch")(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const configPath = path.join(stateDir, "tmux", "terminal-threads.conf");
  const socket = terminalThreadTmuxSocket(stateDir);

  const resolve = Effect.fn("terminalThreads.resolveLaunch")(function* (
    input: TerminalLaunchInput,
  ) {
    if (input.terminalId !== DEFAULT_TERMINAL_ID) return null;
    if (input.runtimeEnv?.[TERMINAL_THREAD_ENV] !== "1") return null;
    const current = yield* settings.getSettings.pipe(Effect.option);
    if (Option.isNone(current)) return null;
    if (!current.value.terminalThreads || !current.value.terminalThreadsTmux) return null;
    const tmux = yield* resolveCommandPath("tmux", { env: input.spawnEnv });
    if (tmux === null) {
      yield* Effect.logWarning("Terminal thread runs a plain shell: tmux is not installed.", {
        threadId: input.threadId,
      });
      return null;
    }
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(
      configPath,
      terminalThreadTmuxConfig(current.value.terminalHistoryLines),
    );
    // The tmux server keeps the environment of the client that started it, so each session
    // gets its own thread and project variables explicitly.
    const sessionEnv: Record<string, string> = {
      ...input.runtimeEnv,
      [T3_TERMINAL_THREAD_ID_ENV]: input.threadId,
    };
    delete sessionEnv[TERMINAL_THREAD_ENV];
    const session = terminalThreadTmuxSession(input.threadId);
    const shell = {
      shell: tmux,
      args: [
        "-u",
        "-L",
        socket,
        // `-f /dev/null` keeps the user's own tmux config out. The config loads with source-file
        // on every attach, so a tmux server that outlived a T3 update takes the new config too.
        "-f",
        "/dev/null",
        "start-server",
        ";",
        "source-file",
        configPath,
        ";",
        "new-session",
        "-A",
        ...Object.entries(sessionEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        "-s",
        session,
      ],
    } satisfies ShellCandidate;
    // `send-keys -H` writes bytes to the pane, so tmux never reads them as keys.
    const passthroughWrite = (data: string) =>
      processRunner
        .run({
          command: tmux,
          args: [
            "-L",
            socket,
            "send-keys",
            "-t",
            session,
            "-H",
            ...[...new TextEncoder().encode(data)].map((byte) => byte.toString(16)),
          ],
          timeout: "5 seconds",
        })
        .pipe(
          Effect.asVoid,
          Effect.catch((cause) =>
            Effect.logWarning("tmux passthrough write failed.", {
              threadId: input.threadId,
              cause,
            }),
          ),
        );
    const shellPid = processRunner
      .run({
        command: tmux,
        args: ["-L", socket, "display-message", "-p", "-t", session, "#{pane_pid}"],
        timeout: "5 seconds",
      })
      .pipe(
        Effect.map((result) => {
          const pid = Number.parseInt(result.stdout.trim(), 10);
          return Number.isInteger(pid) && pid > 0 ? pid : null;
        }),
        Effect.orElseSucceed(() => null),
      );
    return { shell, passthroughWrite, shellPid } satisfies TerminalLaunch;
  });

  return (input: TerminalLaunchInput): Effect.Effect<TerminalLaunch | null> =>
    resolve(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.catch((cause) =>
        Effect.logWarning("Terminal thread runs a plain shell: the tmux launch failed.", {
          threadId: input.threadId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
});
