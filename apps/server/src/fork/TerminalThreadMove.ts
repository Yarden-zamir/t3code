/**
 * Fork: moves a running drawer terminal, with its output, to the main terminal of a new terminal
 * thread in the same project and folder. The model of the thread is the shell of the terminal.
 * A drawer terminal has no shell integration, so the thread shows Done or Failed only when the
 * shell exits, and a message is typed without a result.
 */
import {
  CommandId,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_TERMINAL_ID,
  ForkMoveTerminalToThreadError,
  type ForkMoveTerminalToThreadInput,
  isTerminalThread,
  TERMINAL_THREAD_INSTANCE_ID,
  TERMINAL_THREAD_MODEL_SELECTION,
  terminalThreadTitle,
} from "@t3tools/contracts";
import { terminalThreadLaunch } from "@t3tools/shared/terminalThreadLaunch";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class TerminalThreadMove extends Context.Service<
  TerminalThreadMove,
  {
    readonly moveToThread: (
      input: ForkMoveTerminalToThreadInput,
    ) => Effect.Effect<void, ForkMoveTerminalToThreadError>;
  }
>()("t3/fork/TerminalThreadMove") {}

const failWith = (detail: string) => new ForkMoveTerminalToThreadError({ detail });
const failFrom = (error: { readonly message: string }) => failWith(error.message);

export const layer = Layer.effect(
  TerminalThreadMove,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projects = yield* ProjectStoreV2;
    const settings = yield* ServerSettings.ServerSettingsService;

    const moveToThread = Effect.fn("TerminalThreadMove.moveToThread")(function* (
      input: ForkMoveTerminalToThreadInput,
    ) {
      if (!(yield* settings.getSettings.pipe(Effect.mapError(failFrom))).terminalThreads) {
        return yield* failWith("Turn on Settings > Terminal > Terminal threads.");
      }
      const source = yield* threads.getThreadShell(input.threadId).pipe(Effect.mapError(failFrom));
      if (source === null) return yield* failWith("The thread of the terminal does not exist.");
      if (input.terminalId === DEFAULT_TERMINAL_ID && isTerminalThread(source)) {
        return yield* failWith("This terminal is a terminal thread already.");
      }
      const project = yield* projects.get(source.projectId).pipe(Effect.mapError(failFrom));
      if (Option.isNone(project)) {
        return yield* failWith("The project of the terminal does not exist.");
      }
      const launch = terminalThreadLaunch({
        workspaceRoot: project.value.workspaceRoot,
        worktreePath: source.worktreePath,
      });
      yield* terminals
        .forkMoveSession({
          from: { threadId: input.threadId, terminalId: input.terminalId },
          to: { threadId: input.newThreadId, terminalId: DEFAULT_TERMINAL_ID },
          launch: { cwd: launch.cwd, worktreePath: launch.worktreePath, env: { ...launch.env } },
          // The thread comes first, so a failed create leaves the terminal in its drawer.
          prepare: ({ summary, shell }) =>
            threads
              .dispatch({
                type: "thread.create",
                createdBy: "user",
                creationSource: "web",
                commandId: CommandId.make(`fork-terminal-move:${input.newThreadId}`),
                threadId: input.newThreadId,
                projectId: source.projectId,
                // Limit: a drawer shell reports no command line, and the process poll names its
                // program about once per second. A move in that second gets the shell's name.
                // Revisit if users move terminals right after they start a program.
                title: terminalThreadTitle({
                  command: summary.command,
                  program: summary.hasRunningSubprocess ? summary.label : undefined,
                  shell: shell ?? undefined,
                }),
                modelSelection: {
                  instanceId: TERMINAL_THREAD_INSTANCE_ID,
                  model: shell ?? TERMINAL_THREAD_MODEL_SELECTION.model,
                },
                runtimeMode: DEFAULT_RUNTIME_MODE,
                interactionMode: "default",
                branch: source.branch,
                worktreePath: source.worktreePath,
              })
              .pipe(Effect.asVoid, Effect.mapError(failFrom)),
        })
        .pipe(
          Effect.catchTags({
            TerminalSessionLookupError: () => Effect.fail(failWith("The terminal is closed.")),
            TerminalNotRunningError: () =>
              Effect.fail(failWith("The shell of the terminal does not run.")),
          }),
        );
    });

    return TerminalThreadMove.of({ moveToThread });
  }),
);
