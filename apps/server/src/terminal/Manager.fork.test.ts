import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalEvent,
  type TerminalCustomShell,
  type TerminalOpenInput,
  TERMINAL_THREAD_ENV,
} from "@t3tools/contracts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import type { ShellIntegration } from "../fork/shellIntegration.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "./Manager.ts";

/** Exits when it is killed, as a shell does, so the manager shuts down without waiting. */
class FakePty implements PtyAdapter.PtyProcess {
  readonly pid = 4242;
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private readonly dataListeners = new Set<(data: string) => void>();
  write() {}
  resize() {}
  kill() {
    for (const listener of this.exitListeners) listener({ exitCode: 0, signal: 15 });
  }
  emit(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onExit(listener: (event: PtyAdapter.PtyExitEvent) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
}

/** Spawns succeed until `failNext`, which fails the next spawn as a missing file would. */
const makeFakePtyAdapter = () => {
  const spawnInputs: Array<PtyAdapter.PtySpawnInput> = [];
  const processes: Array<FakePty> = [];
  let failNext = false;
  return {
    spawnInputs,
    processes,
    failNextSpawn: () => {
      failNext = true;
    },
    adapter: {
      spawn: (input: PtyAdapter.PtySpawnInput) => {
        spawnInputs.push(input);
        if (!failNext) {
          const process = new FakePty();
          processes.push(process);
          return Effect.succeed<PtyAdapter.PtyProcess>(process);
        }
        failNext = false;
        return Effect.fail(
          new PtyAdapter.PtySpawnError({
            adapter: "fake",
            shell: input.shell,
            cause: new Error("posix_spawnp failed."),
          }),
        );
      },
    },
  };
};

// Marks a spawn that got the hook, so a test can see that a shell ran without it.
const markingIntegration: ShellIntegration = (candidate, env) => ({
  candidate: { ...candidate, args: ["--integrated"] },
  env: { ...env, T3_TEST_INTEGRATED: "1" },
});

const createManager = (options: {
  readonly forkShells?: Parameters<typeof TerminalManager.makeWithOptions>[0]["forkShells"];
  readonly subprocessInspector?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["subprocessInspector"];
  readonly customShells?: Ref.Ref<ReadonlyArray<TerminalCustomShell>>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { join } = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-terminal-fork-" });
    const pty = makeFakePtyAdapter();
    const manager = yield* TerminalManager.makeWithOptions({
      logsDir: join(baseDir, "logs"),
      ptyAdapter: pty.adapter,
      shellResolver: () => "/bin/default-shell",
      env: { PATH: "/usr/bin" },
      processKillGraceMs: 1,
      forkShellIntegration: markingIntegration,
      ...(options.forkShells === undefined ? {} : { forkShells: options.forkShells }),
      ...(options.subprocessInspector === undefined
        ? {}
        : { subprocessInspector: options.subprocessInspector, subprocessPollIntervalMs: 20 }),
      ...(options.customShells === undefined
        ? {}
        : { forkCustomShells: Ref.get(options.customShells) }),
    });
    const events = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
    const unsubscribe = yield* manager.subscribe((event) =>
      Ref.update(events, (current) => [...current, event]),
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    return {
      manager,
      pty,
      events: Ref.get(events),
      errorMessages: Ref.get(events).pipe(Effect.map(errorMessagesOf)),
    };
  });

const errorMessagesOf = (events: ReadonlyArray<TerminalEvent>) =>
  events.flatMap((event) => (event.type === "error" ? [event.message] : []));

const threadScreen = (shell: string): TerminalOpenInput => ({
  threadId: "thread-1",
  terminalId: DEFAULT_TERMINAL_ID,
  cwd: process.cwd(),
  cols: 100,
  rows: 24,
  env: { [TERMINAL_THREAD_ENV]: "1" },
  shell,
});

const uvOnPath = (command: string, _platform: NodeJS.Platform, env: NodeJS.ProcessEnv) =>
  command === "uv" && env.PATH?.includes("/usr/bin") ? "/usr/bin/uv" : undefined;

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
)("TerminalManager fork shells", (it) => {
  it.effect("fails a chosen shell that cannot start, without a fallback to another shell", () =>
    Effect.gen(function* () {
      const { manager, pty, errorMessages } = yield* createManager({
        forkShells: [{ name: "fish", path: "/opt/fish/bin/fish" }],
      });
      pty.failNextSpawn();

      const snapshot = yield* manager.open(threadScreen("fish"));

      expect(snapshot.status).toBe("error");
      expect(pty.spawnInputs.map((input) => input.shell)).toEqual(["/opt/fish/bin/fish"]);
      expect((yield* errorMessages).join(" ")).toContain("/opt/fish/bin/fish");
    }),
  );

  it.effect("runs a custom shell with its arguments from the terminal PATH, without the hook", () =>
    Effect.gen(function* () {
      const customShells = yield* Ref.make<ReadonlyArray<TerminalCustomShell>>([
        { name: "python", executable: "uv", args: ["run", "python"] },
      ]);
      const { manager, pty } = yield* createManager({ customShells });

      const snapshot = yield* manager.open(threadScreen("python"));

      expect(snapshot.status).toBe("running");
      expect(pty.spawnInputs).toHaveLength(1);
      expect(pty.spawnInputs[0]).toMatchObject({ shell: "/usr/bin/uv", args: ["run", "python"] });
      expect(pty.spawnInputs[0]?.env.T3_TEST_INTEGRATED).toBeUndefined();
    }).pipe(Effect.provideService(SpawnExecutableResolution, uvOnPath)),
  );

  it.effect(
    "keeps the output of a thread whose custom shell was removed, and names the shell",
    () =>
      Effect.gen(function* () {
        const customShells = yield* Ref.make<ReadonlyArray<TerminalCustomShell>>([
          { name: "python", executable: "uv", args: ["run", "python"] },
        ]);
        const { manager, pty } = yield* createManager({ customShells });
        yield* manager.open(threadScreen("python"));
        const printed = yield* Deferred.make<void>();
        const stop = yield* manager.subscribe((event) =>
          event.type === "output"
            ? Deferred.succeed(printed, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        pty.processes[0]?.emit(">>> print(1)\r\n1\r\n");
        yield* Deferred.await(printed);
        stop();
        pty.processes[0]?.kill();
        // The open waits for the debounced history write of that output.
        yield* TestClock.adjust("1 second");

        yield* Ref.set(customShells, []);
        // Start a new shell, and an attach after a reload, open the thread screen again.
        const snapshot = yield* manager.open(threadScreen("python"));

        expect(snapshot.status).toBe("error");
        expect(pty.spawnInputs).toHaveLength(1);
        expect(snapshot.history.indexOf('"python" is not defined')).toBeGreaterThan(
          snapshot.history.indexOf("print(1)"),
        );
        expect(snapshot.history).toContain("print(1)");
      }).pipe(Effect.provideService(SpawnExecutableResolution, uvOnPath)),
  );

  it.effect("fails a custom shell whose executable is missing, with its name", () =>
    Effect.gen(function* () {
      const customShells = yield* Ref.make<ReadonlyArray<TerminalCustomShell>>([
        { name: "repl", executable: "missing-repl", args: [] },
      ]);
      const { manager, pty, errorMessages } = yield* createManager({ customShells });

      const snapshot = yield* manager.open(threadScreen("repl"));

      expect(snapshot.status).toBe("error");
      expect(pty.spawnInputs).toHaveLength(0);
      // In the history too, because an attach gets the snapshot and drops the error event.
      expect(snapshot.history).toContain('"missing-repl" is not an executable file');
      expect(yield* errorMessages).toEqual([
        'The shell "repl" cannot start: "missing-repl" is not an executable file, and not on the PATH of the terminal.',
      ]);
    }).pipe(Effect.provideService(SpawnExecutableResolution, uvOnPath)),
  );

  it.effect("lists only the shells that can start when a shell is not defined", () =>
    Effect.gen(function* () {
      const customShells = yield* Ref.make<ReadonlyArray<TerminalCustomShell>>([
        { name: "python", executable: "uv", args: ["run", "python"] },
        { name: "ghost", executable: "missing-repl", args: [] },
      ]);
      const { manager, errorMessages } = yield* createManager({
        forkShells: [{ name: "zsh", path: "/bin/zsh" }],
        customShells,
      });

      yield* manager.open(threadScreen("removed"));

      expect((yield* errorMessages).join(" ")).toContain("This server has: zsh, python.");
    }).pipe(Effect.provideService(SpawnExecutableResolution, uvOnPath)),
  );

  it.effect("gives a detected shell the hook", () =>
    Effect.gen(function* () {
      const { manager, pty } = yield* createManager({
        forkShells: [{ name: "bash", path: "/bin/bash" }],
      });

      yield* manager.open(threadScreen("bash"));

      expect(pty.spawnInputs[0]).toMatchObject({ shell: "/bin/bash", args: ["--integrated"] });
    }),
  );

  it.effect("reports a program in a detected shell, not the child process of a custom shell", () =>
    Effect.gen(function* () {
      const customShells = yield* Ref.make<ReadonlyArray<TerminalCustomShell>>([
        { name: "python", executable: "uv", args: ["run", "python"] },
      ]);
      const { manager, events } = yield* createManager({
        forkShells: [{ name: "fish", path: "/opt/fish/bin/fish" }],
        customShells,
        subprocessInspector: () =>
          Effect.succeed({ hasRunningSubprocess: true, childCommand: "python", processIds: [1] }),
      });
      // Without the thread env, so no hook state hides what the poll reports.
      const { env: _env, ...fish } = threadScreen("fish");
      const { env: _pythonEnv, ...python } = threadScreen("python");
      yield* manager.open({ ...fish, threadId: "fish-thread" });
      yield* manager.open({ ...python, threadId: "python-thread" });

      yield* TestClock.adjust("50 millis");

      const runningThreads = (yield* events).flatMap((event) =>
        event.type === "activity" && event.hasRunningSubprocess ? [event.threadId] : [],
      );
      expect(new Set(runningThreads)).toEqual(new Set(["fish-thread"]));
    }).pipe(Effect.provideService(SpawnExecutableResolution, uvOnPath)),
  );

  it.effect(
    "moves a running drawer terminal, with its process and output, to a thread screen",
    () =>
      Effect.gen(function* () {
        const { manager, pty, events } = yield* createManager({});
        const drawer: TerminalOpenInput = {
          threadId: "chat-1",
          terminalId: "term-2",
          cwd: process.cwd(),
          cols: 100,
          rows: 24,
        };
        yield* manager.open(drawer);
        const printed = yield* Deferred.make<void>();
        const stop = yield* manager.subscribe((event) =>
          event.type === "output"
            ? Deferred.succeed(printed, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        pty.processes[0]?.emit("make test\r\n");
        yield* Deferred.await(printed);
        stop();
        // The history file is written after a debounce, and the move waits for that write.
        yield* TestClock.adjust("1 second");

        const screen = { ...threadScreenWithoutShell, threadId: "terminal-1" };
        const prepared: Array<string | null> = [];
        yield* manager.forkMoveSession({
          from: { threadId: "chat-1", terminalId: "term-2" },
          to: { threadId: "terminal-1", terminalId: DEFAULT_TERMINAL_ID },
          launch: { cwd: screen.cwd, worktreePath: null, env: { ...screen.env } },
          prepare: ({ shell }) => Effect.sync(() => void prepared.push(shell)),
        });

        expect(prepared).toEqual([null]);
        // The thread screen attaches to the same process, with the output of the drawer.
        const snapshot = yield* manager.open(screen);
        expect(pty.spawnInputs).toHaveLength(1);
        expect(snapshot).toMatchObject({ status: "running", pid: 4242, history: "make test\r\n" });
        const keys = (yield* events).flatMap((event) =>
          event.type === "closed" || event.type === "started"
            ? [`${event.type} ${event.threadId}/${event.terminalId}`]
            : [],
        );
        expect(keys).toEqual([
          "started chat-1/term-2",
          "closed chat-1/term-2",
          "started terminal-1/term-1",
        ]);
        const moved = yield* Effect.flip(manager.write({ ...drawer, data: "x" }));
        expect(moved._tag).toBe("TerminalSessionLookupError");
      }),
  );

  it.effect("moves nothing when the preparation fails", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager({});
      const drawer: TerminalOpenInput = {
        threadId: "chat-1",
        terminalId: "term-2",
        cwd: process.cwd(),
        cols: 100,
        rows: 24,
      };
      yield* manager.open(drawer);

      const error = yield* Effect.flip(
        manager.forkMoveSession({
          from: { threadId: "chat-1", terminalId: "term-2" },
          to: { threadId: "terminal-1", terminalId: DEFAULT_TERMINAL_ID },
          launch: { cwd: process.cwd(), worktreePath: null, env: {} },
          prepare: () => Effect.fail("thread.create failed" as const),
        }),
      );

      expect(error).toBe("thread.create failed");
      yield* manager.write({ ...drawer, data: "still here" });
    }),
  );
  it.effect("keeps the output of a thread screen when an open restarts it elsewhere", () =>
    Effect.gen(function* () {
      const { manager, pty } = yield* createManager({});
      yield* manager.open(threadScreenWithoutShell);
      const printed = yield* Deferred.make<void>();
      const stop = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(printed, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      pty.processes[0]?.emit("old output\r\n");
      yield* Deferred.await(printed);
      stop();
      // The open waits for the debounced history write of that output.
      yield* TestClock.adjust("1 second");

      // Another client opens it with another folder, which restarts the shell.
      const snapshot = yield* manager.open({ ...threadScreenWithoutShell, cwd: "/" });

      expect(pty.spawnInputs).toHaveLength(2);
      expect(snapshot.history).toContain("old output");
      // The new shell starts below the old output, under a marker line.
      expect(snapshot.history.indexOf("new shell")).toBeGreaterThan(
        snapshot.history.indexOf("old output"),
      );
    }),
  );
});

const threadScreenWithoutShell: TerminalOpenInput & { readonly env: Record<string, string> } = {
  threadId: "thread-1",
  terminalId: DEFAULT_TERMINAL_ID,
  cwd: process.cwd(),
  cols: 100,
  rows: 24,
  env: { [TERMINAL_THREAD_ENV]: "1" },
};
