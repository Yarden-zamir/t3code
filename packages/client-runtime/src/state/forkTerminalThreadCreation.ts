/**
 * Fork: how web and mobile create a terminal thread. Web makes its draft a thread on the first
 * command or with the enlarge button; mobile has no draft and creates the thread at once.
 */
import {
  DEFAULT_RUNTIME_MODE,
  type ProjectId,
  type ServerProvider,
  TERMINAL_THREAD_INSTANCE_ID,
  TERMINAL_THREAD_MODEL_SELECTION,
  type ThreadId,
  terminalThreadTitle,
} from "@t3tools/contracts";

import type { CreateThreadInput } from "../operations/commands.ts";

/**
 * The shells with the hook that reports exit codes and output to agents (`shellIntegration.ts` on
 * the server). Limit: bash older than 4.4 has the name but no hook; revisit if the server reports it.
 */
export const TERMINAL_REPORTING_SHELLS: ReadonlySet<string> = new Set(["bash", "zsh"]);

/** The shells that the server of an environment offers, default shell first. */
export function terminalShellOptions(providers: ReadonlyArray<ServerProvider>) {
  return (
    providers
      .find((provider) => provider.instanceId === TERMINAL_THREAD_INSTANCE_ID)
      ?.models.filter((model) => model.isLegacy !== true) ?? []
  );
}

/**
 * The shell of a new terminal thread. A remembered shell that the server no longer offers, such
 * as a removed custom shell, falls back to the default shell. Undefined while the server offers
 * no shells.
 */
export function resolveTerminalShell(
  shells: ReadonlyArray<{ readonly slug: string }>,
  wanted: string | null | undefined,
): string | undefined {
  return shells.find((shell) => shell.slug === wanted)?.slug ?? shells[0]?.slug;
}

/**
 * Where the shell of a new terminal thread runs. A shell needs a folder that exists, so a new
 * worktree is a separate step before the shell starts.
 */
export type TerminalThreadWorkspace =
  | {
      readonly kind: "folder";
      /** Null runs the shell in the project root. */
      readonly worktreePath: string | null;
      readonly branch: string | null;
    }
  | {
      readonly kind: "new-worktree";
      /** Null until the user or the default branch names a base. */
      readonly baseBranch: string | null;
      readonly startFromOrigin: boolean;
    };

/** The workspace choice of a new thread (local or new worktree), as a terminal reads it. */
export function terminalThreadWorkspace(selection: {
  readonly mode: "local" | "worktree";
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly startFromOrigin: boolean;
}): TerminalThreadWorkspace {
  return selection.mode === "worktree"
    ? {
        kind: "new-worktree",
        baseBranch: selection.branch,
        startFromOrigin: selection.startFromOrigin,
      }
    : { kind: "folder", worktreePath: selection.worktreePath, branch: selection.branch };
}

/**
 * The `thread.create` input of a terminal thread. Its model is its shell, and the legacy model
 * means the default shell. The title follows `terminalThreadTitle`: a thread without a command
 * yet is named after its shell, and its screen renames it after the first command.
 */
export function terminalThreadCreateInput(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** Undefined means the default shell of the server. */
  readonly shell: string | undefined;
  /** The command line that made a draft a thread; undefined when none ran yet. */
  readonly command?: string | undefined;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly createdAt: string;
}): CreateThreadInput {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    title: terminalThreadTitle({ command: input.command, shell: input.shell }),
    modelSelection: {
      instanceId: TERMINAL_THREAD_INSTANCE_ID,
      model: input.shell ?? TERMINAL_THREAD_MODEL_SELECTION.model,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
    branch: input.branch,
    worktreePath: input.worktreePath,
    createdAt: input.createdAt,
  };
}
