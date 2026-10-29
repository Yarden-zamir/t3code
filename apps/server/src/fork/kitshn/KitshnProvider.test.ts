import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type MachineCommandInput,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as MachineHost from "../machineMap/MachineHost.ts";
import * as KitshnCli from "./KitshnCli.ts";
import * as KitshnProvider from "./KitshnProvider.ts";

interface FakeChild {
  readonly args: ReadonlyArray<string>;
  /** The requests that T3 wrote to stdin, parsed. */
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
  collectDiagnostics: {
    ok: true,
    result: {
      processes: [{ pid: 7, command: "/usr/bin/node /srv/server.js --token abc123" }],
      recentErrors: [
        {
          message:
            "open https://t3.example/pair#token=PAIRSECRET failed with GITHUB_TOKEN=gh-value and Bearer jwt-value",
        },
      ],
    },
    error: null,
  },
};

const setup = (options: { readonly enabled: boolean; readonly installed?: boolean }) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const children = yield* Queue.unbounded<FakeChild>();
    const binaryCalls = yield* Queue.unbounded<void>();
    const ran = yield* Queue.unbounded<string>();
    const restarted = yield* Deferred.make<void>();
    const settingChanges = yield* Queue.unbounded<ServerSettingsValue>();
    const settings = (kitshnProvider: boolean): ServerSettingsValue => ({
      ...DEFAULT_SERVER_SETTINGS,
      kitshnProvider,
    });

    const layer = KitshnProvider.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ServerConfig.ServerConfig, {
            ...config,
            devUrl: undefined,
            baseDir: "/home/owner/.t3",
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(settings(options.enabled)),
            streamChanges: Stream.fromQueue(settingChanges),
          }),
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
          Layer.mock(MachineHost.MachineHost)({
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
              Queue.offer(ran, `${commandId} ${input._tag}`).pipe(
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
            getDescriptor: Effect.succeed({
              environmentId: EnvironmentId.make("environment:kitshn"),
              label: "studio",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "1.2.3",
              capabilities: { repositoryIdentity: false },
            }),
          }),
        ),
      ),
    );
    const context = yield* Layer.build(layer).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.HomeDirectory, "/home/owner"),
    );
    const provider = Context.get(context, KitshnProvider.KitshnProvider);
    yield* Effect.forkScoped(provider.run);
    return {
      provider,
      children,
      binaryCalls,
      ran,
      restarted,
      setEnabled: (enabled: boolean) => Queue.offer(settingChanges, settings(enabled)),
    };
  });

const EXPECTED_REGISTER = {
  type: "register",
  provider: "t3",
  kinds: [
    { id: "t3.app", name: "T3 app", levels: { view: "read", use: "standard", control: "admin" } },
    { id: "t3.thread", name: "T3 thread", levels: { view: "view", use: "send" } },
    { id: "t3.agents", name: "T3 agents", levels: { use: "use", control: "exec" } },
  ],
  commands: [
    { id: "restart-server", title: "Restart server", kinds: ["t3.app"], confirm: true },
    { id: "install-update", title: "Install update when idle", kinds: ["t3.app"], confirm: true },
    { id: "stop-all-agents", title: "Stop all agents", kinds: ["t3.app"], confirm: true },
    {
      id: "pause-scheduled-tasks",
      title: "Pause scheduled tasks",
      kinds: ["t3.app"],
      confirm: true,
    },
    { id: "collect-diagnostics", title: "Collect diagnostics", kinds: ["t3.app"], confirm: false },
  ],
  resources: [
    {
      id: "app",
      kind: "t3.app",
      name: "T3 on studio",
      status: "running",
      facts: [
        { label: "Version", value: "1.2.3", role: "version" },
        { label: "Running turns", value: "1", role: "busy" },
      ],
    },
  ],
};

const command = (commandId: number, name: string) => ({
  type: "command",
  provider: "t3",
  commandId,
  command: name,
  resource: "app",
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "kitshn-provider-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("KitshnProvider", (it) => {
  it.effect("registers on connect and again on each reconnect", () =>
    Effect.gen(function* () {
      const harness = yield* setup({ enabled: true });
      const first = yield* Queue.take(harness.children);
      expect(first.args).toEqual(["provider"]);
      const register = yield* Queue.take(first.written);
      expect(register).toEqual({ id: expect.any(String), ...EXPECTED_REGISTER });
      expect(register.resources).not.toContainEqual(
        expect.objectContaining({ site: expect.anything() }),
      );
      yield* first.say({
        id: register.id,
        type: "register",
        machineId: "m-1",
        grants: { app: [] },
      });
      yield* first.exit(1);
      yield* TestClock.adjust("5 seconds");
      const second = yield* Queue.take(harness.children);
      expect(yield* Queue.take(second.written)).toEqual({
        id: expect.any(String),
        ...EXPECTED_REGISTER,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("answers each command once, skips bad lines and refuses unknown commands", () =>
    Effect.gen(function* () {
      const harness = yield* setup({ enabled: true });
      const child = yield* Queue.take(harness.children);
      const register = yield* Queue.take(child.written);
      const grant = {
        circle: {
          id: "c",
          name: "Team",
          match: "any",
          needsPasskey: false,
          rules: [{ everyone: true }, { passkeyGroup: "future rule type" }],
        },
        level: "read",
        endsAt: null,
      };
      yield* child.say({
        id: register.id,
        type: "register",
        machineId: "m-1",
        grants: { app: [grant] },
      });
      yield* child.say("not json");
      yield* child.say({ type: "something-new" });
      yield* child.say(command(7, "collect-diagnostics"));
      const result = yield* Queue.take(child.written);
      expect(result).toMatchObject({
        type: "command-result",
        provider: "t3",
        commandId: 7,
        ok: true,
      });
      expect(yield* Queue.take(harness.ran)).toBe("kitshn:7 collectDiagnostics");
      const output = String(result.output);
      expect(output).toContain('"node"');
      for (const secret of ["abc123", "PAIRSECRET", "gh-value", "jwt-value", "server.js"]) {
        expect(output).not.toContain(secret);
      }
      yield* child.say(command(8, "format-disk"));
      expect(yield* Queue.take(child.written)).toMatchObject({
        type: "command-result",
        commandId: 8,
        ok: false,
      });
      expect(yield* harness.provider.grants).toEqual({ app: [grant] });
    }).pipe(Effect.scoped),
  );

  it.effect("answers a restart before it restarts", () =>
    Effect.gen(function* () {
      const harness = yield* setup({ enabled: true });
      const child = yield* Queue.take(harness.children);
      yield* Queue.take(child.written);
      yield* child.say(command(9, "restart-server"));
      expect(yield* Queue.take(child.written)).toMatchObject({ commandId: 9, ok: true });
      expect(yield* Deferred.isDone(harness.restarted)).toBe(false);
      yield* TestClock.adjust("500 millis");
      yield* Deferred.await(harness.restarted);
    }).pipe(Effect.scoped),
  );

  it.effect("runs normally without kitshn and tries again later", () =>
    Effect.gen(function* () {
      const harness = yield* setup({ enabled: true, installed: false });
      yield* Queue.take(harness.binaryCalls);
      yield* TestClock.adjust("10 seconds");
      yield* Queue.take(harness.binaryCalls);
      expect(yield* Queue.size(harness.children)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("follows the setting: off spawns nothing, on starts and off stops the child", () =>
    Effect.gen(function* () {
      const harness = yield* setup({ enabled: false });
      yield* harness.setEnabled(true);
      const child = yield* Queue.take(harness.children);
      // The first spawn is the one after the switch: nothing ran while the setting was off.
      expect(yield* Queue.takeAll(harness.binaryCalls)).toHaveLength(1);
      yield* harness.setEnabled(false);
      yield* Deferred.await(child.stopped);
    }).pipe(Effect.scoped),
  );
});
