import { it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  ProjectId,
  TERMINAL_THREAD_ENV,
  TERMINAL_THREAD_INSTANCE_ID,
  TerminalThreadsOffError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import { makeAttachCounts } from "./terminalSessionFork.ts";
import {
  terminalThreadAttach,
  terminalThreadAttachStream,
  terminalThreadOpen,
  type TerminalThreadLaunchServices,
} from "./terminalThreadShellFill.ts";

const services = (
  thread: { providerInstanceId: string; model: string } | null,
  options: {
    terminalThreads?: boolean;
    terminals?: Partial<TerminalThreadLaunchServices["terminals"]>;
  } = {},
) =>
  ({
    terminals: options.terminals,
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
    projects: { get: () => Effect.succeedSome({ workspaceRoot: "/repo" }) },
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

it.effect("counts an attach stream as attached for its whole life, also through a resync", () =>
  Effect.gen(function* () {
    const counts = makeAttachCounts();
    const key = `draft-1/${DEFAULT_TERMINAL_ID}`;
    const attachedAtResync: Array<boolean> = [];
    const output = (data: string) => ({
      type: "output" as const,
      threadId: "draft-1",
      terminalId: DEFAULT_TERMINAL_ID,
      sequence: 1,
      data,
    });
    const draft = services(null, {
      terminals: {
        forkRetainAttach: (attach) => counts.retain(`${attach.threadId}/${attach.terminalId}`),
        // More output than the stream queues, so the stream drops it and resyncs.
        attachStream: (_input, listener) =>
          Effect.gen(function* () {
            for (let chunk = 0; chunk < 3; chunk++) {
              yield* listener(output("x".repeat(5 * 1024 * 1024)));
            }
            return () => {};
          }),
        resyncStream: (_input, listener) =>
          Effect.gen(function* () {
            attachedAtResync.push(counts.has(key));
            yield* listener(output("after resync"));
            return () => {};
          }),
      },
    });

    const events = yield* terminalThreadAttachStream(draft, {
      ...input(DEFAULT_TERMINAL_ID),
      threadId: "draft-1",
    }).pipe(Stream.take(1), Stream.runCollect);

    expect(events.map((event) => event.type === "output" && event.data)).toEqual(["after resync"]);
    expect(attachedAtResync).toEqual([true]);
    expect(counts.has(key)).toBe(false);
  }),
);
