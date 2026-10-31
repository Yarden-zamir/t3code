import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MachineCommandInput,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ForkUpdates from "../ForkUpdates.ts";
import * as MachineHost from "../machineMap/MachineHost.ts";
import * as ThreadIdentity from "../ThreadIdentity.ts";
import * as KitshnCli from "./KitshnCli.ts";
import * as KitshnConnection from "./KitshnConnection.ts";
import { registerAnswer } from "./KitshnConnection.testkit.ts";
import { threadResourceId } from "./kitshnGrantRules.ts";
import * as KitshnProvider from "./KitshnProvider.ts";
import type { SharedThread } from "./sharedThreads.ts";

interface FakeChild {
  readonly args: ReadonlyArray<string>;
  /** The lines that T3 wrote to stdin, parsed. */
  readonly written: Queue.Queue<Record<string, unknown>>;
  readonly say: (line: string | object) => Effect.Effect<void>;
  readonly exit: (code: number) => Effect.Effect<void>;
  readonly stopped: Deferred.Deferred<void>;
}

const makeChild = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<string, Cause.Done>();
    const written = yield* Queue.unbounded<Record<string, unknown>>();
    const exited = yield* Deferred.make<number>();
    const stopped = yield* Deferred.make<void>();
    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Deferred.await(exited).pipe(Effect.map(ChildProcessSpawner.ExitCode)),
      isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.forEach((chunk: Uint8Array) =>
        Effect.forEach(
          new TextDecoder()
            .decode(chunk)
            .split("\n")
            .filter((line) => line !== ""),
          (line) => Queue.offer(written, JSON.parse(line) as Record<string, unknown>),
          { discard: true },
        ),
      ),
      stdout: Stream.fromQueue(stdout).pipe(Stream.encodeText),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
    const child: FakeChild = {
      args,
      written,
      say: (line) =>
        Queue.offer(stdout, `${typeof line === "string" ? line : JSON.stringify(line)}\n`).pipe(
          Effect.asVoid,
        ),
      exit: (code) =>
        Queue.end(stdout).pipe(Effect.andThen(Deferred.succeed(exited, code)), Effect.asVoid),
      stopped,
    };
    return { handle, child };
  });

const RESULTS: Partial<Record<MachineCommandInput["_tag"], MachineHost.CommandOutcome>> = {
  restartServer: { ok: true, result: { restarting: true }, error: null, restartAfterReply: true },
};

const IDENTITY = {
  active: true,
  threadId: ThreadId.make("thread-1"),
  threadTitle: "Fix the build",
  projectId: ProjectId.make("project-1"),
  projectName: "t3code",
  environmentId: EnvironmentId.make("environment:kitshn"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
  interactionMode: "default",
  subagent: false,
  parentThreadId: null,
  parentEnvironmentId: null,
  checkedAt: "2026-10-30T00:00:00.000Z",
} as const;

const setup = (options: { readonly installed?: boolean; readonly switchOff?: boolean } = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const children = yield* Queue.unbounded<FakeChild>();
    const binaryCalls = yield* Queue.unbounded<void>();
    const ran = yield* Queue.unbounded<string>();
    const restarted = yield* Deferred.make<void>();
    const shared = yield* Ref.make<ReadonlyArray<SharedThread>>([]);
    const channels = yield* Queue.unbounded<string>();
    const connection = yield* KitshnConnection.make;
    const events = yield* connection.subscribe;

    const layer = Layer.effect(
      KitshnProvider.KitshnProvider,
      KitshnProvider.make(Effect.asSome(Ref.get(shared))),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(KitshnConnection.KitshnConnection, connection),
          Layer.succeed(ServerConfig.ServerConfig, { ...config, devUrl: undefined, port: 3773 }),
          Layer.mock(KitshnCli.KitshnCli)({
            binary: Queue.offer(binaryCalls, undefined).pipe(
              Effect.andThen(
                options.installed === false
                  ? Effect.fail(
                      new KitshnCli.KitshnCliError({
                        reason: "not_installed",
                        message: "This machine has no kitshn 2.",
                      }),
                    )
                  : Effect.succeed("/home/owner/.local/bin/kitshn"),
              ),
            ),
          }),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              Effect.gen(function* () {
                const { handle, child } = yield* makeChild(
                  command._tag === "StandardCommand" ? command.args : [],
                );
                yield* Effect.addFinalizer(() => Deferred.succeed(child.stopped, undefined));
                yield* Queue.offer(children, child);
                return handle;
              }),
            ),
          ),
          Layer.mock(ForkUpdates.ForkUpdates)({
            available: false,
            setChannel: (channel) => Queue.offer(channels, channel).pipe(Effect.asVoid),
          }),
          Layer.mock(MachineHost.MachineHost)({
            status: () => Effect.succeed(STATUS as never),
            isDesktopCommand: () => false,
            supervised: true,
            supportedCommands: () => [
              "restartServer",
              "installUpdate",
              "stopAllAgents",
              "pauseScheduledTasks",
              "collectDiagnostics",
            ],
            runInput: (commandId, input) =>
              Queue.offer(
                ran,
                `${commandId} ${input._tag}${"sessionId" in input ? ` ${input.sessionId}` : ""}`,
              ).pipe(
                Effect.andThen(input._tag === "pauseScheduledTasks" ? Effect.never : Effect.void),
                Effect.as(RESULTS[input._tag] ?? { ok: true, result: { done: true }, error: null }),
              ),
            restartProcess: Deferred.succeed(restarted, undefined).pipe(Effect.asVoid),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: () =>
              Effect.succeed({
                threads: [{ activeRunId: "run:1" }, { activeRunId: null }],
              } as never),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:kitshn")),
            getDescriptor: Effect.succeed({
              environmentId: EnvironmentId.make("environment:kitshn"),
              label: "studio",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "1.2.3",
              capabilities: { repositoryIdentity: false },
            }),
          }),
          Layer.mock(ThreadIdentity.ThreadIdentity)({
            check: (token) =>
              token === "slow"
                ? Effect.never
                : Effect.succeed(token === "live" ? IDENTITY : { active: false }),
          }),
        ),
      ),
    );
    const context = yield* Layer.build(layer).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.HomeDirectory, "/home/owner"),
      Effect.provideService(
        HostProcess.Environment,
        options.switchOff === true ? { T3CODE_KITSHN: "off" } : {},
      ),
    );
    const provider = Context.get(context, KitshnProvider.KitshnProvider);
    yield* Effect.forkScoped(provider.run);
    /** The first child, registered with the answer of kitshn's daemon. */
    const registered = (answer: Partial<KitshnConnection.RegisterAnswer> = {}) =>
      Effect.gen(function* () {
        const child = yield* Queue.take(children);
        const register = yield* Queue.take(child.written);
        yield* child.say(registerAnswer({ ...answer, id: String(register.id) }));
        // The connection is attached once the register answer is handled.
        yield* connection.live.pipe(
          Stream.filter((live) => live !== null),
          Stream.runHead,
        );
        return { child, register };
      });
    return {
      provider,
      connection,
      events,
      shared,
      children,
      binaryCalls,
      ran,
      restarted,
      channels,
      registered,
    };
  });

const STATUS = {
  tasks: [
    {
      id: "daily",
      title: "Daily digest",
      enabled: true,
      schedule: "Every day at 09:00",
      nextRunAt: "2026-10-30T06:00:00.000Z",
      lastRunAt: null,
      lastRunStatus: null,
      lastRunError: null,
    },
  ],
  clients: [
    {
      // Real session ids can be longer than 64 characters; kitshn takes row ids up to 200.
      sessionId: `session-${"x".repeat(70)}`,
      label: null,
      subject: "phone",
      deviceType: "mobile",
      os: "Android",
      browser: null,
      connected: true,
      lastSeenAt: null,
    },
  ],
};

const command = (
  commandId: number,
  name: string,
  row: string | null = null,
  deadline = 300_000,
) => ({
  type: "command",
  commandId,
  command: name,
  resource: "app",
  row,
  deadline,
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "kitshn-provider-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("KitshnProvider (protocol 2)", (it) => {
  it.effect("registers with protocol 2 and its instance, and again 1 second after an exit", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const { child, register } = yield* harness.registered();
      expect(child.args).toEqual(["provider"]);
      expect(register).toMatchObject({
        type: "register",
        protocol: 2,
        provider: "t3",
        instance: "environment:kitshn",
        clients: [{ id: "t3code-fork" }],
      });
      const kinds = (register.kinds as ReadonlyArray<{ id: string }>).map((kind) => kind.id);
      expect(kinds).toEqual(["t3.app", "t3.thread", "t3.settings"]);
      const [app, ...others] = register.resources as ReadonlyArray<Record<string, unknown>>;
      expect(others).toEqual([]);
      // K-705: kitshn names the site, also of a machine without a portal tunnel.
      expect(app).toMatchObject({ id: "app", kind: "t3.app", site: { port: 3773 } });
      expect(app?.site).toEqual({ port: 3773 });
      yield* child.exit(1);
      yield* TestClock.adjust("1 second");
      const second = yield* Queue.take(harness.children);
      expect(yield* Queue.take(second.written)).toMatchObject({ type: "register", protocol: 2 });
    }).pipe(Effect.scoped),
  );

  it.effect("answers each ping, and drops a daemon that is silent for graceMs (C-7, C-8)", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const { child } = yield* harness.registered({ graceMs: 2000 });
      yield* child.say({ type: "ping", at: 1 });
      expect(yield* Queue.take(child.written)).toEqual({ type: "pong" });
      yield* TestClock.adjust("1999 millis");
      expect(yield* Deferred.isDone(child.stopped)).toBe(false);
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(child.stopped);
      const connection = yield* harness.provider.connection.pipe(Stream.runHead);
      expect(Option.getOrThrow(connection)).toMatchObject({
        status: "connecting",
        detail: "kitshn sent nothing for 2s, so T3 ended the connection",
      });
      // K-1611: the next registered connection says why T3 ended the last one, and when.
      // A child that T3 ended itself backs off, so a refusing daemon gets no tight loop.
      yield* TestClock.adjust("5 seconds");
      const second = yield* Queue.take(harness.children);
      const again = yield* Queue.take(second.written);
      yield* second.say(registerAnswer({ id: String(again.id) }));
      const registered = yield* harness.provider.connection.pipe(
        Stream.filter((status) => status.status === "registered"),
        Stream.runHead,
      );
      const state = Option.getOrThrow(registered);
      expect(state).toMatchObject({
        status: "registered",
        detail: "kitshn sent nothing for 2s, so T3 ended the connection",
      });
      // Between the drop and the next try.
      const restartedAt = state.status === "registered" ? state.restartedAt : null;
      expect(restartedAt).toBeGreaterThanOrEqual(2000);
      expect(restartedAt).toBeLessThanOrEqual(7000);
    }).pipe(Effect.scoped),
  );

  it.effect("answers each command once, by its row id, and before kitshn's deadline", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const { child, register } = yield* harness.registered();
      yield* child.say("not json");
      yield* child.say({ type: "something-new", field: 1 });
      yield* child.say(command(7, "collect-diagnostics"));
      expect(yield* Queue.take(child.written)).toMatchObject({
        type: "command-result",
        provider: "t3",
        commandId: 7,
        ok: true,
      });
      expect(yield* Queue.take(harness.ran)).toBe("kitshn:7 collectDiagnostics");
      yield* child.say(command(8, "format-disk"));
      expect(yield* Queue.take(child.written)).toMatchObject({ commandId: 8, ok: false });
      // K-1625: a row id is the prefix and the id itself, also past 64 characters.
      const rows = (
        register.resources as ReadonlyArray<{
          lists?: ReadonlyArray<{ rows: ReadonlyArray<{ id: string }> }>;
        }>
      )[0]?.lists?.[1]?.rows;
      expect(rows?.[0]?.id).toBe(`session:session-${"x".repeat(70)}`);
      yield* child.say(command(9, "revoke-session", rows?.[0]?.id ?? null));
      expect(yield* Queue.take(child.written)).toMatchObject({ commandId: 9, ok: true });
      expect(yield* Queue.take(harness.ran)).toBe(
        `kitshn:9 revokeClient session-${"x".repeat(70)}`,
      );
      yield* child.say(command(10, "revoke-session", "task:daily"));
      expect(yield* Queue.take(child.written)).toMatchObject({ commandId: 10, ok: false });
      // A command that runs past the deadline gets its failure in time for the job.
      yield* child.say(command(11, "pause-scheduled-tasks", null, 10_000));
      yield* Queue.take(harness.ran);
      yield* TestClock.adjust("8 seconds");
      expect(yield* Queue.take(child.written)).toMatchObject({
        commandId: 11,
        ok: false,
        output: "The command did not finish before kitshn's deadline.",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("ends a child that the daemon no longer knows, and registers on a new one", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const { child } = yield* harness.registered();
      yield* child.say({
        id: "7",
        type: "error",
        error: "register t3 on this connection first (K-704).",
      });
      yield* Deferred.await(child.stopped);
      yield* TestClock.adjust("5 seconds");
      const second = yield* Queue.take(harness.children);
      expect(yield* Queue.take(second.written)).toMatchObject({ type: "register", protocol: 2 });
    }).pipe(Effect.scoped),
  );

  it.effect("answers a restart before it restarts", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const { child } = yield* harness.registered();
      yield* child.say(command(9, "restart-server"));
      expect(yield* Queue.take(child.written)).toMatchObject({ commandId: 9, ok: true });
      expect(yield* Deferred.isDone(harness.restarted)).toBe(false);
      yield* TestClock.adjust("500 millis");
      yield* Deferred.await(harness.restarted);
    }).pipe(Effect.scoped),
  );

  it.effect("runs normally without kitshn, and stays off with T3CODE_KITSHN=off", () =>
    Effect.gen(function* () {
      const missing = yield* setup({ installed: false });
      yield* Queue.take(missing.binaryCalls);
      yield* TestClock.adjust("5 seconds");
      yield* Queue.take(missing.binaryCalls);
      expect(yield* Queue.size(missing.children)).toBe(0);

      const off = yield* setup({ switchOff: true });
      const status = yield* off.provider.connection.pipe(
        Stream.filter((connection) => connection.status === "off"),
        Stream.runHead,
      );
      expect(Option.getOrThrow(status).detail).toBe("turned off by T3CODE_KITSHN=off");
      expect(yield* Queue.size(off.binaryCalls)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("upserts and removes the cards of shared threads as shares change", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const share = (threadId: string) => ({
        threadId,
        title: `Thread ${threadId}`,
        shareId: `share-${threadId}`,
        host: "t3-studio.example.com",
        expiresAt: "2100-01-01T00:00:00.000Z",
      });
      yield* Ref.set(harness.shared, [share("t1")]);
      const { child, register } = yield* harness.registered();
      expect((register.resources as ReadonlyArray<{ id: string }>).map((card) => card.id)).toEqual([
        "app",
        threadResourceId("t1"),
      ]);
      yield* Ref.set(harness.shared, [share("t2")]);
      yield* TestClock.adjust("15 seconds");
      expect(yield* Queue.take(child.written)).toMatchObject({
        type: "remove",
        ids: [threadResourceId("t1")],
      });
      expect(yield* Queue.take(child.written)).toMatchObject({
        type: "upsert",
        resources: [{ id: threadResourceId("t2"), kind: "t3.thread", parent: "app" }],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps what kitshn says: settings, reach, problems, sync, results", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      // Before kitshn answers the register, nothing goes out.
      const early = yield* Effect.flip(harness.connection.request({ type: "samples" }));
      expect(early.message).toContain("no connection to kitshn");
      const reached = {
        machineId: "m-2",
        machineName: "vps",
        kind: "t3.app",
        id: "app",
        address: "t3-vps.example.com",
        level: "use",
      };
      const problem = { path: "resources[0].lists[1].rows[3]", reason: "too long; row dropped" };
      const { child } = yield* harness.registered({
        problems: [problem],
        syncedAt: 1000,
        linkSocket: "/run/kitshn/link.sock",
        saved: {
          desired: { "t3.settings": { shared: { server: {}, client: {} }, machine: null } },
          settings: { app: { updateChannel: "daily" } },
          reach: [reached],
          served: [],
        },
      });
      // K-717: the T3 card's update channel reaches the updater.
      expect(yield* Queue.take(harness.channels)).toBe("nightly");
      expect(yield* Queue.take(harness.channels)).toBe("daily");
      expect(yield* harness.provider.linkSocket).toBe("/run/kitshn/link.sock");
      const stateNow = harness.provider.state.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      expect(yield* stateNow).toMatchObject({
        reach: [reached],
        problems: [problem],
        syncedAt: 1000,
        paused: false,
      });
      // Local requests go over the live connection; an error answer fails with its text.
      const asking = yield* harness.connection
        .request({ type: "job-cancel", jobId: 42 })
        .pipe(Effect.forkChild);
      const sent = yield* Queue.take(child.written);
      expect(sent).toEqual({ id: expect.any(String), type: "job-cancel", jobId: 42 });
      yield* child.say({ id: sent.id, type: "error", error: "not queued" });
      expect((yield* Effect.flip(Fiber.join(asking))).message).toBe("not queued");
      // K-721: a pause comes in `sync`; results of asks and jobs are kept for machines_read.
      yield* child.say({ type: "sync", syncedAt: 2000, paused: true });
      yield* child.say({ type: "ask-result", proposalId: "p1", outcome: "approved" });
      yield* child.say({
        type: "job-result",
        jobId: 7,
        state: "done",
        exitCode: 0,
        output: "ok",
      });
      yield* child.say({ type: "grants-changed", at: 3 });
      // Events that other services read go to the connection, after the lines before them.
      expect(yield* PubSub.take(harness.events)).toEqual({ type: "grants-changed", at: 3 });
      expect(yield* stateNow).toMatchObject({ syncedAt: 2000, paused: true });
      expect(yield* harness.provider.askResults).toMatchObject([{ proposalId: "p1" }]);
      expect(yield* harness.provider.jobResults).toMatchObject([{ jobId: 7, state: "done" }]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "attests a live thread with bare labels, and refuses an inactive or slow one (C-12)",
    () =>
      Effect.gen(function* () {
        const harness = yield* setup();
        const { child } = yield* harness.registered();
        yield* child.say({ type: "attest", attestId: "a1", token: "live" });
        expect(yield* Queue.take(child.written)).toMatchObject({
          type: "attest-result",
          attestId: "a1",
          active: true,
          labels: {
            "thread.id": "thread-1",
            "thread.title": "Fix the build",
            "project.name": "t3code",
            subagent: "false",
            "thread.parent": "",
          },
        });
        yield* child.say({ type: "attest", attestId: "a2", token: "revoked" });
        expect(yield* Queue.take(child.written)).toEqual({
          id: expect.any(String),
          type: "attest-result",
          attestId: "a2",
          active: false,
        });
        // K-1752: kitshn refuses after 2 seconds, so T3 answers inactive before.
        yield* child.say({ type: "attest", attestId: "a3", token: "slow" });
        yield* TestClock.adjust("1800 millis");
        expect(yield* Queue.take(child.written)).toMatchObject({ attestId: "a3", active: false });
      }).pipe(Effect.scoped),
  );

  it.effect("shows a refused register, and replaces a child that never answers it", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const first = yield* Queue.take(harness.children);
      const register = yield* Queue.take(first.written);
      // C-2, C-4: a refusal of the whole register names its reason.
      yield* first.say({
        id: register.id,
        type: "error",
        error: "the provider t3 is connected as instance other; stop it first",
      });
      const refused = yield* harness.provider.connection.pipe(
        Stream.filter(
          (connection) => connection.status === "connecting" && connection.detail !== null,
        ),
        Stream.runHead,
      );
      expect(Option.getOrThrow(refused).detail).toBe(
        "kitshn refused the registration: the provider t3 is connected as instance other; stop it first",
      );
      yield* TestClock.adjust("5 seconds");
      const second = yield* Queue.take(harness.children);
      yield* Queue.take(second.written);
      yield* TestClock.adjust("10 seconds");
      yield* Deferred.await(second.stopped);
    }).pipe(Effect.scoped),
  );
});
