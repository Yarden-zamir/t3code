import {
  DEFAULT_TERMINAL_ID,
  isTerminalThread,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalError,
  terminalThreadShell,
  TerminalThreadsOffError,
  ThreadId,
} from "@t3tools/contracts";
import { terminalThreadLaunch } from "@t3tools/shared/terminalThreadLaunch";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type * as TerminalManager from "../terminal/Manager.ts";
import { terminalOutputStream } from "../terminal/OutputProtocol.ts";

export interface TerminalThreadLaunchServices {
  readonly threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">;
  readonly projects: Pick<ProjectStoreV2["Service"], "get">;
  readonly settings: Pick<ServerSettings.ServerSettingsService["Service"], "getSettings">;
  readonly terminals: Pick<
    TerminalManager.TerminalManager["Service"],
    "attachStream" | "resyncStream" | "forkRetainAttach" | "forkSavedOutputStream"
  >;
}

/** The fields of `terminal.open`, `terminal.attach` and `terminal.restart` that start a shell. */
interface LaunchInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd?: string | undefined;
  readonly shell?: string | undefined;
}

type Launch<Input> =
  | { readonly type: "launch"; readonly input: Input }
  /** The setting is off: the screen of a terminal thread shows its output and starts no shell. */
  | { readonly type: "readOnly"; readonly cwd: string; readonly worktreePath: string | null };

/**
 * Fork: the main terminal of a terminal thread takes folder, worktree, env and shell from the
 * thread record, because other values from an older client make `terminal.open` restart the
 * program. Drawer terminals keep the client's folder and default to the thread's shell. A draft
 * has no thread record yet, so its client names all of it.
 */
const resolveLaunch = Effect.fn("TerminalThreadLaunch.resolve")(function* <
  Input extends LaunchInput,
>(services: TerminalThreadLaunchServices, input: Input) {
  const enabled = (yield* services.settings.getSettings.pipe(Effect.orDie)).terminalThreads;
  if (!enabled && input.shell !== undefined) return yield* new TerminalThreadsOffError();
  const launch = (next: Input): Launch<Input> => ({ type: "launch", input: next });
  // Without the thread, the client's input stands.
  const thread = yield* services.threads
    .getThreadShell(ThreadId.make(input.threadId))
    .pipe(Effect.orElseSucceed(() => null));
  if (thread === null || !isTerminalThread(thread)) return launch(input);

  const shell = terminalThreadShell(thread.modelSelection.model);
  if (input.terminalId !== DEFAULT_TERMINAL_ID) {
    return launch(
      enabled && shell !== undefined && input.shell === undefined ? { ...input, shell } : input,
    );
  }
  const project = yield* services.projects.get(thread.projectId).pipe(Effect.orDie);
  if (Option.isNone(project)) {
    return yield* Effect.die(new Error(`The project of terminal thread ${thread.id} is missing.`));
  }
  const context = terminalThreadLaunch({
    workspaceRoot: project.value.workspaceRoot,
    worktreePath: thread.worktreePath,
  });
  if (!enabled) {
    return { type: "readOnly", cwd: context.cwd, worktreePath: context.worktreePath } as const;
  }
  // An attach without a folder opens no shell, so it has nothing to replace.
  if (input.cwd === undefined) return launch(input);
  return launch({
    ...input,
    cwd: context.cwd,
    worktreePath: context.worktreePath,
    env: { ...context.env },
    ...(shell === undefined ? {} : { shell }),
  });
});

/** `terminal.open` and `terminal.restart`: a read-only screen starts no shell. */
export const terminalThreadOpen = <Input extends LaunchInput>(
  services: TerminalThreadLaunchServices,
  input: Input,
) =>
  resolveLaunch(services, input).pipe(
    Effect.flatMap((launch) =>
      launch.type === "launch" ? Effect.succeed(launch.input) : new TerminalThreadsOffError(),
    ),
  );

/** `terminal.attach`: a read-only screen gets its output without a shell. */
export const terminalThreadAttach = resolveLaunch;

/**
 * The stream holds its attach count for its whole life, so a resubscribe after an overflow never
 * leaves a gap in which `AbandonedTerminalDrafts` sees a draft screen as abandoned.
 */
export const terminalThreadAttachStream = (
  services: TerminalThreadLaunchServices,
  input: TerminalAttachInput,
) =>
  Stream.unwrap(
    services.terminals.forkRetainAttach(input).pipe(
      Effect.andThen(terminalThreadAttach(services, input)),
      Effect.map((launch) => {
        const { terminals } = services;
        if (launch.type === "readOnly") {
          const saved = { ...input, cwd: launch.cwd, worktreePath: launch.worktreePath };
          const subscribe = (
            listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
            register: (stop: () => void) => void,
          ) => terminals.forkSavedOutputStream(saved, listener, register);
          return terminalOutputStream<TerminalAttachStreamEvent, TerminalError>(
            subscribe,
            subscribe,
          );
        }
        return terminalOutputStream<TerminalAttachStreamEvent, TerminalError>(
          (listener, register) => terminals.attachStream(launch.input, listener, register),
          (listener, register) => terminals.resyncStream(launch.input, listener, register),
        );
      }),
    ),
  );
