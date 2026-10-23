// @effect-diagnostics nodeBuiltinImport:off -- the shell name comes from a path string.
/**
 * Fork: shell integration of terminal threads. The main terminal of a terminal thread starts
 * its shell with a small hook that prints OSC 133 marks (`shellMarks.ts`) when the prompt shows,
 * when a command starts and when it ends with its exit code. The server then knows, without
 * wrapper text in the terminal, whether a program runs and how a command ended.
 *
 * Supported: bash 4.4 or newer and zsh. Another shell runs without the hook and reports no state.
 * An older bash (macOS /bin/bash is 3.2) gets the rcfile but no hook, so it stays `starting`: the
 * first message of each session waits SHELL_READY_TIMEOUT_MS, and the process poll then forgets
 * the state. Revisit if users run terminal threads on bash 3.2. Revisit when a user needs fish; its hook is a function on the
 * `fish_prompt` and `fish_preexec` events.
 */
import * as NodePath from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  TERMINAL_COMMAND_MAX_LENGTH,
  TERMINAL_THREAD_ENV,
} from "@t3tools/contracts";
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
    printf '\\e]133;D;%s\\a\\e]133;A\\a' "$code"
    return "$code"
  }
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__t3_prompt "\${PROMPT_COMMAND[@]}")
  else
    PROMPT_COMMAND="__t3_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  fi
  # The start mark carries the command line from the history, without the control characters
  # that would end the mark. A command that the history skips (HISTCONTROL=ignorespace) reports
  # the command before it.
  __t3_command_line() {
    local line
    line=$(builtin fc -ln -0 2>/dev/null)
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
  # The start mark carries the command line, without the control characters that would end it.
  local line="\${1//[[:cntrl:]]/ }"
  print -rn -- $'\\e]133;C;cmdline='"\${line[1,${COMMAND_LINE_HOOK_LENGTH}]}"$'\\a'
}
precmd_functions=(__t3_precmd $precmd_functions)
preexec_functions+=(__t3_preexec)
# The continuation prompt shows a command that is not complete, such as an open quote.
PS2=$'%{\\e]133;A;k=s\\a%}'"$PS2"
`;

/** The shell command and environment with the hook, or null for a shell without support. */
export type ShellIntegration = (
  candidate: ShellCandidate,
  env: NodeJS.ProcessEnv,
) => { readonly candidate: ShellCandidate; readonly env: NodeJS.ProcessEnv } | null;

export const makeShellIntegration = Effect.fn("makeShellIntegration")(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(stateDir, "shell-integration");
  const zshDir = path.join(root, "zsh");
  const bashRc = path.join(root, "bash.rc");
  yield* fileSystem.makeDirectory(zshDir, { recursive: true });
  yield* fileSystem.writeFileString(bashRc, BASH_RC);
  yield* fileSystem.writeFileString(path.join(zshDir, ".zshenv"), zshForward(".zshenv"));
  yield* fileSystem.writeFileString(path.join(zshDir, ".zprofile"), zshForward(".zprofile"));
  yield* fileSystem.writeFileString(path.join(zshDir, ".zshrc"), ZSHRC);
  yield* fileSystem.writeFileString(path.join(zshDir, ".zlogin"), zshForward(".zlogin"));

  const integrate: ShellIntegration = (candidate, env) => {
    const shell = NodePath.basename(candidate.shell).toLowerCase();
    if (shell === "bash") {
      return { candidate: { ...candidate, args: ["--rcfile", bashRc] }, env };
    }
    if (shell === "zsh") {
      return {
        candidate,
        env: {
          ...env,
          ZDOTDIR: zshDir,
          T3_ZDOTDIR: zshDir,
          T3_USER_ZDOTDIR: env.ZDOTDIR ?? "",
        },
      };
    }
    return null;
  };
  return integrate;
});
