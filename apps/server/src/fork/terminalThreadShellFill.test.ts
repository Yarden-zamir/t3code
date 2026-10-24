import { it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  ProjectId,
  TERMINAL_THREAD_ENV,
  TERMINAL_THREAD_INSTANCE_ID,
  TerminalThreadsOffError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect } from "vite-plus/test";

import {
  terminalThreadAttach,
  terminalThreadOpen,
  type TerminalThreadLaunchServices,
} from "./terminalThreadShellFill.ts";

const services = (
  thread: { providerInstanceId: string; model: string } | null,
  options: { terminalThreads?: boolean } = {},
) =>
  ({
    threads: {
      getThreadShell: () =>
        Effect.succeed(
          thread === null
            ? null
            : {
                id: "thread-1",
                projectId: ProjectId.make("project-1"),
                worktreePath: "/repo/.worktrees/feature",
                providerInstanceId: thread.providerInstanceId,
                modelSelection: { instanceId: thread.providerInstanceId, model: thread.model },
              },
        ),
    },
    projects: { get: () => Effect.succeed(Option.some({ workspaceRoot: "/repo" })) },
    settings: {
      getSettings: Effect.succeed({ terminalThreads: options.terminalThreads ?? true }),
    },
  }) as unknown as TerminalThreadLaunchServices;

const input = (
  terminalId: string,
  extra: { shell?: string; env?: Record<string, string> } = {},
) => ({
  threadId: "thread-1",
  terminalId,
  cwd: "/somewhere/else",
  worktreePath: null,
  ...extra,
});

const terminalThread = { providerInstanceId: TERMINAL_THREAD_INSTANCE_ID, model: "fish" };

it.effect("opens the main terminal of a terminal thread from the thread, not the client", () =>
  Effect.gen(function* () {
    // An older client sends another folder, no worktree, no marker and another shell.
    const opened = yield* terminalThreadOpen(
      services(terminalThread),
      input(DEFAULT_TERMINAL_ID, { shell: "zsh", env: { OTHER: "1" } }),
    );
    expect(opened).toMatchObject({
      cwd: "/repo/.worktrees/feature",
      worktreePath: "/repo/.worktrees/feature",
      shell: "fish",
    });
    expect(opened.env).toMatchObject({ [TERMINAL_THREAD_ENV]: "1" });
    expect(opened.env).not.toHaveProperty("OTHER");
  }),
);

it.effect("gives the drawer terminals of a terminal thread its shell and the client's folder", () =>
  Effect.gen(function* () {
    const open = (shell?: string) =>
      terminalThreadOpen(
        services(terminalThread),
        input("term-2", shell === undefined ? {} : { shell }),
      );
    expect(yield* open()).toMatchObject({ cwd: "/somewhere/else", shell: "fish" });
    // A shell that the client names stands.
    expect((yield* open("zsh")).shell).toBe("zsh");
    // The legacy model means the default shell.
    const legacy = services({ providerInstanceId: TERMINAL_THREAD_INSTANCE_ID, model: "terminal" });
    expect((yield* terminalThreadOpen(legacy, input("term-2"))).shell).toBeUndefined();
  }),
);

it.effect("leaves the terminals of an agent thread and of a draft alone", () =>
  Effect.gen(function* () {
    const agent = services({ providerInstanceId: "codex", model: "gpt-5" });
    expect(yield* terminalThreadOpen(agent, input(DEFAULT_TERMINAL_ID))).toEqual(
      input(DEFAULT_TERMINAL_ID),
    );
    // A draft has no thread record yet, so its client names the folder, env and shell.
    const draft = input(DEFAULT_TERMINAL_ID, { shell: "zsh", env: { [TERMINAL_THREAD_ENV]: "1" } });
    expect(yield* terminalThreadOpen(services(null), draft)).toEqual(draft);
  }),
);

it.effect("starts no shell of a terminal thread while the setting is off", () =>
  Effect.gen(function* () {
    const off = services(terminalThread, { terminalThreads: false });
    const refused = yield* terminalThreadOpen(off, input(DEFAULT_TERMINAL_ID)).pipe(Effect.flip);
    expect(refused).toBeInstanceOf(TerminalThreadsOffError);
    // The screen still attaches, to show its saved output.
    expect(yield* terminalThreadAttach(off, input(DEFAULT_TERMINAL_ID))).toEqual({
      type: "readOnly",
      cwd: "/repo/.worktrees/feature",
      worktreePath: "/repo/.worktrees/feature",
    });
    // A drawer terminal of the thread opens with the default shell.
    expect((yield* terminalThreadOpen(off, input("term-2"))).shell).toBeUndefined();
  }),
);

it.effect("refuses the shell field while the setting is off, on any thread", () =>
  Effect.gen(function* () {
    const offDraft = services(null, { terminalThreads: false });
    const refused = yield* terminalThreadOpen(
      offDraft,
      input(DEFAULT_TERMINAL_ID, { shell: "zsh" }),
    ).pipe(Effect.flip);
    expect(refused).toBeInstanceOf(TerminalThreadsOffError);
  }),
);
