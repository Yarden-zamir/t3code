import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, type MachineCommandInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ForkUpdates from "../ForkUpdates.ts";
import * as MachineHost from "../machineMap/MachineHost.ts";
import * as KitshnCli from "./KitshnCli.ts";
import * as KitshnGrants from "./KitshnGrants.ts";
import { threadResourceId } from "./kitshnGrantRules.ts";
import type { GrantTables } from "./kitshnProviderProtocol.ts";
import * as KitshnProvider from "./KitshnProvider.ts";
import type { SharedThread } from "./sharedThreads.ts";

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
};

const GRANT = {
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

const GRANT_DECODED = {
  ...GRANT,
  circle: { ...GRANT.circle, rules: [{ everyone: true }, { unknown: "passkeyGroup" }] },
};

const setup = (options: { readonly installed?: boolean } = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const children = yield* Queue.unbounded<FakeChild>();
    const binaryCalls = yield* Queue.unbounded<void>();
    const ran = yield* Queue.unbounded<string>();
    const restarted = yield* Deferred.make<void>();
    const tables = yield* Ref.make<GrantTables | null>(null);
    const shared = yield* Ref.make<ReadonlyArray<SharedThread>>([]);
    const machine = yield* Ref.make<KitshnGrants.KitshnMachine | null>(null);
    const linkChecks = yield* Queue.unbounded<string>();
    const linkCheckExit = yield* Ref.make(0);
    const channels = yield* Queue.unbounded<string>();
    const contacts = yield* Ref.make(0);

    const layer = Layer.effect(
      KitshnProvider.KitshnProvider,
      KitshnProvider.make(Effect.asSome(Ref.get(shared))),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(KitshnGrants.KitshnGrants)({
            replaceTables: (next) => Ref.set(tables, next),
            contact: Ref.update(contacts, (count) => count + 1),
            setMachine: (next) => Ref.set(machine, next),
            setPeerOrigins: () => Effect.void,
            setAccess: () => Effect.void,
            trustsPeerOrigin: () => false,
            peerOrigins: () => [],
          }),
          Layer.succeed(ServerConfig.ServerConfig, {
            ...config,
            devUrl: undefined,
            baseDir: "/home/owner/.t3",
            port: 3773,
            tunnelPairingUrl: "https://t3-studio.example.com",
          }),
          Layer.mock(KitshnCli.KitshnCli)({
            linkCheck: (socket) =>
              Queue.offer(linkChecks, socket).pipe(
                Effect.andThen(Ref.get(linkCheckExit)),
                Effect.map((exitCode) => ({ exitCode, stdout: "", stderr: "not this account" })),
              ),
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
      tables,
      shared,
      children,
      binaryCalls,
      ran,
      restarted,
      machine,
      linkChecks,
      channels,
      contacts,
      linkCheckExit,
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
      sessionId: "s-1",
      label: null,
      subject: "owner",
      deviceType: "mobile",
      os: "Android",
      browser: null,
      connected: true,
      lastSeenAt: null,
    },
  ],
};

const EXPECTED_REGISTER = {
  type: "register",
  provider: "t3",
  kinds: [
    {
      id: "t3.app",
      name: "T3 app",
      levels: { view: "read", use: "standard", control: "admin" },
      ownerControl: true,
      settings: [
        {
          id: "updateChannel",
          title: "Update channel",
          values: ["nightly", "daily"],
          default: "nightly",
        },
      ],
    },
    { id: "t3.thread", name: "T3 thread", levels: { view: "view", use: "send" } },
    {
      id: "t3.agents",
      name: "T3 agents",
      levels: { use: "use", control: "exec" },
      ownerControl: true,
    },
    { id: "t3.settings", name: "T3 settings", levels: {}, state: {} },
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
    { id: "run-task", title: "Run now", kinds: ["t3.app"], confirm: true },
    { id: "pause-task", title: "Pause", kinds: ["t3.app"], confirm: false },
    { id: "resume-task", title: "Resume", kinds: ["t3.app"], confirm: false },
    { id: "revoke-session", title: "Revoke session", kinds: ["t3.app"], confirm: true },
  ],
  resources: [
    {
      id: "app",
      kind: "t3.app",
      name: "T3 on studio",
      status: "running",
      // K-1623: the label of the tunnel host and the real port.
      site: { name: "t3-studio", port: 3773 },
      facts: [
        { label: "Version", value: "1.2.3", role: "version" },
        { label: "Running turns", value: "1" },
        { label: "Busy", value: "true", role: "busy" },
      ],
      lists: [
        {
          id: "tasks",
          title: "Scheduled tasks",
          columns: [
            { id: "title", title: "Task" },
            { id: "schedule", title: "Schedule" },
            { id: "state", title: "State" },
            { id: "next", title: "Next run" },
          ],
          rows: [
            {
              id: "task:daily",
              cells: {
                title: "Daily digest",
                schedule: "Every day at 09:00",
                state: "on",
                next: "2026-10-30T06:00:00.000Z",
              },
              commands: ["run-task", "pause-task"],
            },
          ],
        },
        {
          id: "sessions",
          title: "Client sessions",
          columns: [
            { id: "client", title: "Client" },
            { id: "device", title: "Device" },
            { id: "connected", title: "Connected" },
            { id: "lastSeen", title: "Last seen" },
          ],
          rows: [
            {
              id: "session:s-1",
              cells: { client: "owner", device: "mobile, Android", connected: "yes", lastSeen: "" },
              commands: ["revoke-session"],
            },
          ],
        },
      ],
    },
    { id: "agents", kind: "t3.agents", name: "Agents on studio", status: "running", parent: "app" },
  ],
};

/** K-706: after a register answer, the provider asks kitshn for its state to prove contact. */
const takeProbe = (child: FakeChild) =>
  Queue.take(child.written).pipe(
    Effect.tap((line) =>
      Effect.sync(() => expect(line).toMatchObject({ type: "ask", action: "state" })),
    ),
  );

const command = (commandId: number, name: string, row?: string) => ({
  type: "command",
  provider: "t3",
  commandId,
  command: name,
  resource: "app",
  ...(row === undefined ? {} : { row }),
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "kitshn-provider-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("KitshnProvider", (it) => {
  it.effect("registers on connect, and again 1 second after a registered child exits", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const first = yield* Queue.take(harness.children);
      expect(first.args).toEqual(["provider"]);
      const register = yield* Queue.take(first.written);
      expect(register).toEqual({ id: expect.any(String), ...EXPECTED_REGISTER });
      yield* first.say({
        id: register.id,
        type: "register",
        machineId: "m-1",
        grants: { app: [GRANT] },
      });
      // The next line is answered only after the register answer above.
      yield* first.say(command(1, "stop-all-agents"));
      yield* Queue.take(first.written);
      expect(yield* Ref.get(harness.tables)).toEqual({ app: [GRANT_DECODED] });
      yield* first.exit(1);
      yield* TestClock.adjust("1 second");
      const second = yield* Queue.take(harness.children);
      expect(yield* Queue.take(second.written)).toEqual({
        id: expect.any(String),
        ...EXPECTED_REGISTER,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("answers each command once, skips bad lines and refuses unknown commands", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const child = yield* Queue.take(harness.children);
      const register = yield* Queue.take(child.written);
      yield* child.say({
        id: register.id,
        type: "register",
        machineId: "m-1",
        grants: { app: [GRANT] },
      });
      yield* takeProbe(child);
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
      yield* child.say(command(8, "format-disk"));
      expect(yield* Queue.take(child.written)).toMatchObject({
        type: "command-result",
        commandId: 8,
        ok: false,
      });
      // K-1625: a row command runs for its row, and only for a row of its own list.
      yield* child.say(command(9, "pause-task", "task:daily"));
      expect(yield* Queue.take(child.written)).toMatchObject({ commandId: 9, ok: true });
      expect(yield* Queue.take(harness.ran)).toBe("kitshn:9 setScheduledTaskEnabled");
      yield* child.say(command(10, "revoke-session", "task:daily"));
      expect(yield* Queue.take(child.written)).toMatchObject({ commandId: 10, ok: false });
      // An unknown rule type keeps the rest of the table readable.
      expect(yield* Ref.get(harness.tables)).toEqual({ app: [GRANT_DECODED] });
    }).pipe(Effect.scoped),
  );

  it.effect("answers a restart before it restarts", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
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
      const harness = yield* setup({ installed: false });
      yield* Queue.take(harness.binaryCalls);
      yield* TestClock.adjust("5 seconds");
      yield* Queue.take(harness.binaryCalls);
      expect(yield* Queue.size(harness.children)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "registers a card per shared thread, and upserts and removes them as shares change",
    () =>
      Effect.gen(function* () {
        const harness = yield* setup();
        const share = (threadId: string, expiresAt = "2100-01-01T00:00:00.000Z") => ({
          threadId,
          title: `Thread ${threadId}`,
          shareId: `share-${threadId}`,
          host: "t3-studio.example.com",
          expiresAt,
        });
        yield* Ref.set(harness.shared, [share("t1"), share("old", "1970-01-01T00:00:00.000Z")]);
        const child = yield* Queue.take(harness.children);
        const register = yield* Queue.take(child.written);
        const card = (threadId: string) => ({
          id: threadResourceId(threadId),
          kind: "t3.thread",
          name: `Thread ${threadId}`,
          status: "running",
          parent: "app",
          stickers: [
            {
              text: "Open thread",
              tone: "info",
              link: `https://t3-studio.example.com/guest?share=share-${threadId}`,
            },
          ],
        });
        expect(register.resources).toEqual([...EXPECTED_REGISTER.resources, card("t1")]);
        yield* child.say({ id: register.id, type: "register", machineId: "m-1", grants: {} });
        yield* takeProbe(child);

        yield* Ref.set(harness.shared, [share("t2")]);
        yield* TestClock.adjust("15 seconds");
        expect(yield* Queue.take(child.written)).toMatchObject({
          type: "remove",
          ids: [threadResourceId("t1")],
        });
        expect(yield* Queue.take(child.written)).toMatchObject({
          type: "upsert",
          resources: [card("t2")],
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "sends local requests over the live connection and keeps the machine name and channel",
    () =>
      Effect.gen(function* () {
        const harness = yield* setup();
        const child = yield* Queue.take(harness.children);
        const register = yield* Queue.take(child.written);
        // Before kitshn answers the register, nothing goes out.
        const early = yield* Effect.flip(harness.provider.request({ type: "samples" }));
        expect(early.message).toContain("no connection to kitshn");
        // kitshn's full register answer: every field that packages/local/src/index.ts sends.
        yield* child.say({
          id: register.id,
          type: "register",
          machineId: "m-1",
          grants: {},
          desired: { "t3.settings": { shared: { server: {}, client: {} }, machine: null } },
          settings: { app: { updateChannel: "daily" } },
          reach: [
            {
              machineId: "m-2",
              machineName: "vps",
              kind: "t3.app",
              id: "app",
              address: "t3-vps.example.com",
              level: "use",
            },
          ],
          access: null,
          linkSocket: null,
          machineName: "studio",
        });
        // K-717: the T3 card's update channel reaches the updater.
        expect(yield* Queue.take(harness.channels)).toBe("nightly");
        expect(yield* Queue.take(harness.channels)).toBe("daily");
        // K-706: the daemon's own register answer proves no contact with kitshn; kitshn's answer does.
        const probe = yield* takeProbe(child);
        expect(yield* Ref.get(harness.contacts)).toBe(0);
        yield* child.say({ id: probe.id, type: "ask", outcome: "done", result: {} });
        const asking = yield* harness.provider
          .request({ type: "job-cancel", jobId: 42 })
          .pipe(Effect.forkChild);
        const sent = yield* Queue.take(child.written);
        expect(sent).toEqual({ id: expect.any(String), type: "job-cancel", jobId: 42 });
        yield* child.say({ id: sent.id, type: "error", error: "not queued" });
        const refused = yield* Effect.flip(Fiber.join(asking));
        expect(refused.message).toBe("not queued");
        expect(yield* Ref.get(harness.machine)).toEqual({ id: "m-1", name: "studio" });
        const state = Option.getOrThrow(yield* harness.provider.state.pipe(Stream.runHead));
        expect(state.reach.map((card) => card.machineId)).toEqual(["m-2"]);
        expect(yield* Ref.get(harness.contacts)).toBe(1);
        // K-1623: before the handover the host notice shows, also for an empty audience list.
        const hostNotice = harness.provider.hostNotice.pipe(Stream.runHead);
        expect(yield* hostNotice).toEqual(Option.some(true));
        const team = "team.cloudflareaccess.com";
        yield* child.say({
          type: "access",
          provider: "t3",
          access: { teamDomain: team, audiences: [] },
        });
        yield* child.say(command(4, "collect-diagnostics"));
        yield* Queue.take(child.written);
        expect(yield* hostNotice).toEqual(Option.some(true));
        yield* child.say({
          type: "access",
          provider: "t3",
          access: { teamDomain: team, audiences: ["a"] },
        });
        yield* child.say(command(5, "collect-diagnostics"));
        yield* Queue.take(child.written);
        expect(yield* hostNotice).toEqual(Option.some(false));
        // An access push without `served` (an older kitshn) means that kitshn serves no host.
        const served = harness.provider.servedHosts.pipe(Stream.runHead);
        expect(yield* served).toEqual(Option.some([]));
        yield* child.say({
          type: "access",
          provider: "t3",
          access: { teamDomain: team, audiences: ["a"], served: ["t3-studio.example.com"] },
        });
        yield* child.say(command(6, "collect-diagnostics"));
        yield* Queue.take(child.written);
        expect(yield* served).toEqual(Option.some(["t3-studio.example.com"]));
        // K-1722: the answer to a waiting ask is kept for machines_read.
        yield* child.say({ type: "ask-result", proposalId: "p1", outcome: "approved" });
        yield* child.say(command(3, "collect-diagnostics"));
        yield* Queue.take(child.written);
        expect(yield* harness.provider.askResults).toEqual([
          { type: "ask-result", proposalId: "p1", outcome: "approved" },
        ]);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "uses the link socket only after link-check, and drops it when the connection closes",
    () =>
      Effect.gen(function* () {
        const harness = yield* setup();
        const child = yield* Queue.take(harness.children);
        const register = yield* Queue.take(child.written);
        yield* child.say({
          id: register.id,
          type: "register",
          machineId: "m-1",
          machineName: "studio",
          grants: {},
          linkSocket: "/run/kitshn/link.sock",
        });
        // The command result comes only after the register answer above was handled.
        yield* child.say(command(1, "collect-diagnostics"));
        yield* Queue.take(child.written);
        // The first use runs link-check; a passed check holds for later uses.
        expect(yield* harness.provider.linkSocket).toBe("/run/kitshn/link.sock");
        expect(yield* harness.provider.linkSocket).toBe("/run/kitshn/link.sock");
        expect(yield* Queue.takeAll(harness.linkChecks)).toEqual(["/run/kitshn/link.sock"]);

        // A connection error: the next use checks again, and a failed check gives no socket.
        yield* harness.provider.linkSocketFailed("/run/kitshn/link.sock");
        yield* Ref.set(harness.linkCheckExit, 1);
        expect(yield* harness.provider.linkSocket).toBeNull();
        expect(yield* Queue.takeAll(harness.linkChecks)).toEqual(["/run/kitshn/link.sock"]);

        // The connection that gave the socket closes: no call goes to the old path.
        yield* Ref.set(harness.linkCheckExit, 0);
        yield* child.exit(1);
        yield* Deferred.await(child.stopped);
        expect(yield* harness.provider.linkSocket).toBeNull();
        expect(yield* Queue.size(harness.linkChecks)).toBe(0);
      }).pipe(Effect.scoped),
  );
});
