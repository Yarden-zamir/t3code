// @effect-diagnostics nodeBuiltinImport:off -- the tmux socket name comes from the state folder.
/**
 * Fork: the tmux launch of terminal threads (`forkTerminalThreads.ts` in contracts). The main
 * terminal of a terminal thread runs `tmux new-session -A` instead of a shell. The tmux server is
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
  TERMINAL_THREAD_SUPER_KEYS,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { ShellCandidate } from "../terminal/Manager.ts";
import { T3_TERMINAL_THREAD_ID_ENV } from "../terminal/terminalEnv.ts";

export interface TerminalLaunchInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly runtimeEnv: Readonly<Record<string, string>> | null;
  readonly spawnEnv: NodeJS.ProcessEnv;
}

/**
 * What the web terminal sends for the Command key (Super), and what the app must receive. tmux
 * reads the Super bit as Meta, so each one is a tmux user key that sends the shell sequence
 * unchanged. The Command arrows travel as themselves: tmux matches a user key before it reads
 * them as extended keys. The editor letters travel as private sequences, because tmux reads the
 * CSI-u form before it matches user keys.
 */
const SUPER_PASSTHROUGHS: ReadonlyArray<{ readonly wire: string; readonly shell: string }> = [
  ...TERMINAL_THREAD_SUPER_KEYS,
  ...["A", "B", "C", "D"].flatMap((arrow) =>
    [`\u001b[1;9${arrow}`, `\u001b[1;10${arrow}`].map((sequence) => ({
      wire: sequence,
      shell: sequence,
    })),
  ),
];

const FIRST_PASSTHROUGH_USER_KEY = 1;

function superPassthroughLines(): ReadonlyArray<string> {
  return SUPER_PASSTHROUGHS.flatMap(({ wire, shell }, index) => {
    const userKey = FIRST_PASSTHROUGH_USER_KEY + index;
    const hex = [...shell].map((character) => character.charCodeAt(0).toString(16)).join(" ");
    return [
      `set -s user-keys[${userKey}] "${wire.replace("\u001b", "\\e")}"`,
      `bind -n User${userKey} send-keys -H ${hex}`,
    ];
  });
}

/**
 * No status line and no prefix key, so every key reaches the app. Mouse mode lets the wheel
 * scroll the tmux history. The user key opens an incremental search of that history. Extended
 * keys let Ctrl and Shift arrows through.
 */
export const TERMINAL_THREAD_TMUX_CONFIG = [
  "set -g extended-keys on",
  "set -g status off",
  "set -g prefix None",
  "set -g prefix2 None",
  "set -g mouse on",
  "set -g history-limit 50000",
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
  ...superPassthroughLines(),
  "",
].join("\n");

export function terminalThreadTmuxSocket(stateDir: string): string {
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  return `t3code-${hash}`;
}

export function terminalThreadTmuxSession(threadId: string): string {
  return `t3-${threadId}`;
}

export const makeTerminalThreadLaunch = Effect.fn("makeTerminalThreadLaunch")(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const configPath = path.join(stateDir, "tmux", "terminal-threads.conf");
  const socket = terminalThreadTmuxSocket(stateDir);

  const resolve = Effect.fn("terminalThreads.resolveLaunch")(function* (
    input: TerminalLaunchInput,
  ) {
    if (input.terminalId !== DEFAULT_TERMINAL_ID) return null;
    if (input.runtimeEnv?.[TERMINAL_THREAD_ENV] !== "1") return null;
    const enabled = yield* settings.getSettings.pipe(
      Effect.map((current) => current.terminalThreads),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) return null;
    const tmux = yield* resolveCommandPath("tmux", { env: input.spawnEnv });
    if (tmux === null) {
      yield* Effect.logWarning("Terminal thread runs a plain shell: tmux is not installed.", {
        threadId: input.threadId,
      });
      return null;
    }
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(configPath, TERMINAL_THREAD_TMUX_CONFIG);
    // The tmux server keeps the environment of the client that started it, so each session
    // gets its own thread and project variables explicitly.
    const sessionEnv: Record<string, string> = {
      ...input.runtimeEnv,
      [T3_TERMINAL_THREAD_ID_ENV]: input.threadId,
    };
    delete sessionEnv[TERMINAL_THREAD_ENV];
    return {
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
        terminalThreadTmuxSession(input.threadId),
      ],
    } satisfies ShellCandidate;
  });

  return (input: TerminalLaunchInput): Effect.Effect<ShellCandidate | null> =>
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
