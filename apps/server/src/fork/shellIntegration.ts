// @effect-diagnostics nodeBuiltinImport:off -- the shell name comes from a path string.
/**
 * Fork: the main terminal of a terminal thread starts its shell with a hook that prints OSC 133
 * marks (`shellMarks.ts`), so the server knows whether a program runs and how a command ended.
 * Supported: bash 4.4 or newer and zsh. An older bash (macOS 3.2) gets no hook and stays
 * `starting`, so a first message waits SHELL_READY_TIMEOUT_MS. Revisit for bash 3.2 or fish users.
 */
import * as NodePath from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  TERMINAL_COMMAND_MAX_LENGTH,
  TERMINAL_THREAD_ENV,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import type { ShellCandidate } from "../terminal/Manager.ts";

/** The main terminal of a terminal thread is the screen of the thread. */
export function isTerminalThreadMainTerminal(
  terminalId: string,
  runtimeEnv: Readonly<Record<string, string>> | null,
): boolean {
  return terminalId === DEFAULT_TERMINAL_ID && runtimeEnv?.[TERMINAL_THREAD_ENV] === "1";
}

/** The hook cuts a long command line, so its mark stays far below MAX_PENDING_CHARS. */
const COMMAND_LINE_HOOK_LENGTH = TERMINAL_COMMAND_MAX_LENGTH + 20;

const BASH_RC = `# Written by T3 Code: reports where the shell stands to the terminal thread.
[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
# PS0 needs bash 4.4.
if [[ \${BASH_VERSINFO[0]} -gt 4 || (\${BASH_VERSINFO[0]} -eq 4 && \${BASH_VERSINFO[1]} -ge 4) ]]; then
  __t3_prompt() {
    local code=$?
    __t3_histcmd=$HISTCMD
    printf '\\e]133;D;%s\\a\\e]133;A\\a' "$code"
    return "$code"
  }
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__t3_prompt "\${PROMPT_COMMAND[@]}")
  else
    PROMPT_COMMAND="__t3_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  fi
  # The start mark carries the command line from the history, without the control characters
  # that would end the mark. A command that the history skips (HISTCONTROL=ignorespace or
  # ignoredups) leaves HISTCMD as the prompt saw it. fc prints a tab and a space before the line.
  # A command that starts with a space has no command line, because users type secrets that way.
  __t3_command_line() {
    local line
    if [[ $HISTCMD != "$__t3_histcmd" ]]; then
      line=$(builtin fc -ln -0 2>/dev/null)
      line="\${line:2}"
    fi
    if [[ -z "$line" || "$line" == " "* ]]; then
      printf '\\e]133;C\\a'
      return
    fi
    line="\${line//[[:cntrl:]]/ }"
    printf '\\e]133;C;cmdline=%s\\a' "\${line:0:${COMMAND_LINE_HOOK_LENGTH}}"
  }
  if shopt -q promptvars; then
    PS0='$(__t3_command_line)'"\${PS0:-}"
  else
    PS0=$'\\e]133;C\\a'"\${PS0:-}"
  fi
  # The continuation prompt shows a command that is not complete, such as an open quote.
  PS2='\\[\\e]133;A;k=s\\a\\]'"\${PS2-> }"
  # A message arrives as a paste, so all of its lines run as one command line.
  bind 'set enable-bracketed-paste on' 2>/dev/null
fi
`;

/**
 * zsh reads these four files from $ZDOTDIR, so each forwards to the file of the user. A file of
 * the user can move ZDOTDIR (often to ~/.config/zsh), and zsh reads the next file from there.
 */
const ZSH_USER_ZDOTDIR = `# The user files see ZDOTDIR as zsh would: unset unless the user set it.
if [[ -n "$T3_USER_ZDOTDIR" ]]; then ZDOTDIR="$T3_USER_ZDOTDIR"; else unset ZDOTDIR; fi`;

const zshForward = (file: string) => `# Written by T3 Code: forwards to the ${file} of the user.
${ZSH_USER_ZDOTDIR}
[[ -f "\${ZDOTDIR:-$HOME}/${file}" ]] && . "\${ZDOTDIR:-$HOME}/${file}"
T3_USER_ZDOTDIR="\${ZDOTDIR-}"
ZDOTDIR="$T3_ZDOTDIR"
`;

const ZSHRC = `# Written by T3 Code: loads the .zshrc of the user, then reports where the shell stands.
${ZSH_USER_ZDOTDIR}
[[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && . "\${ZDOTDIR:-$HOME}/.zshrc"
__t3_precmd() { local code=$?; print -rn -- $'\\e]133;D;'"$code"$'\\a\\e]133;A\\a'; return $code }
# PROMPT_SP prints its end-of-line mark before precmd, so the mark would end up in the output of
# the command. Themes such as powerlevel10k turn it on again, so it goes off before each command.
__t3_preexec() {
  setopt no_prompt_sp
  # A command that starts with a space has no command line, because users type secrets that way.
  if [[ "$1" == " "* ]]; then
    print -rn -- $'\\e]133;C\\a'
    return
  fi
  # The start mark carries the command line, without the control characters that would end it.
  local line="\${1//[[:cntrl:]]/ }"
  print -rn -- $'\\e]133;C;cmdline='"\${line[1,${COMMAND_LINE_HOOK_LENGTH}]}"$'\\a'
}
precmd_functions=(__t3_precmd $precmd_functions)
preexec_functions+=(__t3_preexec)
# The continuation prompt shows a command that is not complete, such as an open quote.
PS2=$'%{\\e]133;A;k=s\\a%}'"$PS2"
`;

/**
 * The shell command and environment with the hook. `failed` is a shell that supports the hook
 * while the hook files are missing: it starts without the hook, and the notice goes into the
 * terminal above it.
 */
export type ShellIntegration = (
  candidate: ShellCandidate,
  env: NodeJS.ProcessEnv,
) =>
  | {
      readonly type: "hooked";
      readonly candidate: ShellCandidate;
      readonly env: NodeJS.ProcessEnv;
    }
  | { readonly type: "unsupported" }
  | { readonly type: "failed"; readonly notice: string };

/**
 * Limit: the hook files are written once, at server start. A failed write (a full disk, no
 * permission) turns the hook off until the next server start, and a file removed later breaks
 * the hook of new shells. Revisit if either happens in practice.
 */
export const makeShellIntegration = Effect.fn("makeShellIntegration")(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Git Bash on Windows is `bash.exe`, so the name comes without the extension.
  const shellPath = (yield* HostProcess.Platform) === "win32" ? NodePath.win32 : NodePath.posix;
  const root = path.join(stateDir, "shell-integration");
  const zshDir = path.join(root, "zsh");
  const bashRc = path.join(root, "bash.rc");
  const writeError = yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(zshDir, { recursive: true });
    yield* fileSystem.writeFileString(bashRc, BASH_RC);
    yield* fileSystem.writeFileString(path.join(zshDir, ".zshenv"), zshForward(".zshenv"));
    yield* fileSystem.writeFileString(path.join(zshDir, ".zprofile"), zshForward(".zprofile"));
    yield* fileSystem.writeFileString(path.join(zshDir, ".zshrc"), ZSHRC);
    yield* fileSystem.writeFileString(path.join(zshDir, ".zlogin"), zshForward(".zlogin"));
    return null;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Terminal threads run without shell integration.", { root, error }).pipe(
        Effect.as(error.message),
      ),
    ),
  );
  // The same form as the start errors of the terminal manager.
  const notice =
    writeError === null
      ? null
      : `\r\n[terminal] Shell integration is off, so this thread shows no command results: ${writeError}\r\n`;

  const integrate: ShellIntegration = (candidate, env) => {
    const shell = shellPath.parse(candidate.shell).name.toLowerCase();
    if (shell !== "bash" && shell !== "zsh") return { type: "unsupported" };
    if (notice !== null) return { type: "failed", notice };
    if (shell === "bash") {
      return { type: "hooked", candidate: { ...candidate, args: ["--rcfile", bashRc] }, env };
    }
    return {
      type: "hooked",
      candidate,
      env: {
        ...env,
        ZDOTDIR: zshDir,
        T3_ZDOTDIR: zshDir,
        T3_USER_ZDOTDIR: env.ZDOTDIR ?? "",
      },
    };
  };
  return integrate;
});
