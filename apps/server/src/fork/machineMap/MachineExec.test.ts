import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { withThreadCredential } from "@t3tools/provider-core/server/forkThreadCredential";
import {
  EnvironmentId,
  MACHINE_EXEC_MAX_OUTPUT_BYTES,
  type MachineDesiredState,
  type MachineExecReport,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as NetAddress from "effect/net/NetAddress";
import { HttpServer } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { machineRequestNamespace } from "./machineAccess.ts";
import * as MachineExec from "./MachineExec.ts";
import { arrow, desiredState, PEER, SELF } from "./MachineMap.testkit.ts";
import * as MachineMap from "./MachineMap.ts";
import * as MachineMapState from "./MachineMapState.ts";
import * as MachinePeers from "./MachinePeers.ts";

/** A session of the peer on this machine, as `McpOAuth` admits it. */
const peerSession: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mac"),
  requestNamespace: machineRequestNamespace({ machineId: PEER, sessionId: "session-1" }),
  thread: undefined,
  client: { sessionId: "session-1", label: "machine VPS", access: "full-access" },
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 0,
};

const threadId = ThreadId.make("thread:exec-caller");
const localThread: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mac"),
  requestNamespace: "provider:exec-caller",
  thread: {
    threadId,
    providerSessionId: "provider:exec-caller",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 0,
};

const execArrowIn = arrow(PEER, SELF, "standard", { agentTools: true, exec: true });
const execArrowOut = arrow(SELF, PEER, "standard", { agentTools: true, exec: true });

const localState = (desired: MachineDesiredState): MachineMapState.LocalState => ({
  enabled: true,
  clientAccess: "off",
  portalUrl: "https://portal.example.com",
  token: { clientId: "mac-token", secret: "test-secret" },
  saved: {
    desired,
    desiredAtMs: 0,
    handledCommandIds: [],
    pausedTaskIds: [],
    desktopCommands: [],
    pendingRevokes: [],
    pendingClientAccess: null,
  },
});

const harness = Effect.fn("MachineExecTest.harness")(function* (input: {
  readonly desired: MachineDesiredState;
  readonly processRunner?: Layer.Layer<ProcessRunner.ProcessRunner>;
}) {
  const state = yield* SubscriptionRef.make(localState(input.desired));
  const reports: Array<MachineExecReport> = [];
  const requests: Array<string> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url);
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 403 }));
    }),
  );
  const layerState = Layer.mock(MachineMapState.MachineMapState)({
    clientSeen: yield* Queue.unbounded<never>(),
    trustsPeerOrigin: () => false,
    peerOrigins: () => [],
    snapshot: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    activeDesired: SubscriptionRef.get(state).pipe(
      Effect.map((local) => (local.enabled ? local.saved.desired : null)),
    ),
  });
  const layer = MachineExec.layer.pipe(
    Layer.provide(MachinePeers.layer),
    Layer.provide(layerState),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(
      Layer.mock(MachineMap.MachineMap)({
        reportExec: (report) => Effect.sync(() => void reports.push(report)),
      }),
    ),
    Layer.provide(
      input.processRunner ?? ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provide(NodeServices.layer),
  );
  const exec = (
    scope: McpInvocationContext.McpInvocationScope,
    command: Parameters<MachineExec.MachineExec["Service"]["exec"]>[0],
    modes: Parameters<typeof liveThreadShell>[1] = {},
  ) =>
    MachineExec.MachineExec.pipe(
      Effect.flatMap((machineExec) => machineExec.exec(command)),
      Effect.provide(layer),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId, modes)),
        }),
      ),
    );
  return { state, reports, requests, exec };
});

it.live("runs a command for a peer whose arrow allows exec, and reports it", () =>
  Effect.gen(function* () {
    const { exec, reports } = yield* harness({
      desired: desiredState({ arrowsIn: [execArrowIn] }),
    });
    const result = yield* exec(peerSession, {
      machine: SELF,
      command: "printf %s-%s out put; printf oops >&2; exit 3",
      cwd: "/",
      caller: { threadId: "thread:on-vps", threadTitle: "Deploy check" },
    });
    expect(result).toMatchObject({
      machine: "Mac",
      outcome: "exited",
      exitCode: 3,
      stdout: "out-put",
      stderr: "oops",
      cwd: "/",
    });
    expect(reports).toEqual([
      expect.objectContaining({
        from: PEER,
        threadId: "thread:on-vps",
        threadTitle: "Deploy check",
        command: "printf %s-%s out put; printf oops >&2; exit 3",
        cwd: "/",
        outcome: "exited",
        exitCode: 3,
      }),
    ]);
    // MM-1908: the History never holds the output.
    expect(JSON.stringify(reports)).not.toContain("out-put");
  }),
);

it.live("caps each stream and marks the cut", () =>
  Effect.gen(function* () {
    const { exec } = yield* harness({ desired: desiredState({ arrowsIn: [execArrowIn] }) });
    const result = yield* exec(peerSession, {
      machine: SELF,
      command: `head -c ${MACHINE_EXEC_MAX_OUTPUT_BYTES + 10_000} /dev/zero | tr '\\0' x`,
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toContain(`[output truncated at ${MACHINE_EXEC_MAX_OUTPUT_BYTES} bytes]`);
    expect(result.stdout.length).toBeLessThan(MACHINE_EXEC_MAX_OUTPUT_BYTES + 100);
  }),
);

it.live("stops a command at its timeout", () =>
  Effect.gen(function* () {
    const { exec, reports } = yield* harness({
      desired: desiredState({ arrowsIn: [execArrowIn] }),
    });
    const result = yield* exec(peerSession, {
      machine: SELF,
      command: "sleep 30",
      timeoutSeconds: 1,
    });
    expect(result).toMatchObject({ outcome: "timedOut", exitCode: null });
    expect(reports.map((report) => report.outcome)).toEqual(["timedOut"]);
  }),
);

it.effect(
  "refuses a peer whose arrow lacks exec, and a call meant for another machine, in History",
  () =>
    Effect.gen(function* () {
      const runs: Array<string> = [];
      const processRunner = Layer.mock(ProcessRunner.ProcessRunner)({
        run: (input) =>
          Effect.sync(() => void runs.push(input.command)).pipe(Effect.andThen(Effect.never)),
      });
      for (const arrowIn of [
        arrow(PEER, SELF, "standard", { agentTools: true }),
        arrow(PEER, SELF, "read", { agentTools: true, exec: true }),
        arrow(PEER, SELF, "admin", { exec: true }),
      ]) {
        const { exec, reports } = yield* harness({
          desired: desiredState({ arrowsIn: [arrowIn] }),
          processRunner,
        });
        const error = yield* exec(peerSession, { machine: SELF, command: "true" }).pipe(
          Effect.flip,
        );
        expect(error.message).toContain("does not allow exec");
        // MM-1908: nothing ran, so the refusal has no exit code; this machine is the target.
        expect(reports).toMatchObject([{ from: PEER, outcome: "refused", exitCode: null }]);
        expect(reports[0]?.reason).toContain("does not allow exec");
        expect(reports[0]).not.toHaveProperty("target");
      }
      const { exec } = yield* harness({
        desired: desiredState({ arrowsIn: [execArrowIn] }),
        processRunner,
      });
      const onward = yield* exec(peerSession, { machine: "other", command: "true" }).pipe(
        Effect.flip,
      );
      expect(onward.message).toContain("runs only on the machine it calls");
      expect(runs).toEqual([]);
    }),
);

it.effect("refuses a call that its machine narrowed below full-access/default (MM-1902)", () =>
  Effect.gen(function* () {
    const runs: Array<string> = [];
    const { exec, reports } = yield* harness({
      desired: desiredState({ arrowsIn: [execArrowIn] }),
      processRunner: Layer.mock(ProcessRunner.ProcessRunner)({
        run: (input) =>
          Effect.sync(() => void runs.push(input.command)).pipe(Effect.andThen(Effect.never)),
      }),
    });
    for (const narrowedTo of [
      { runtimeMode: "auto", interactionMode: "default" },
      { runtimeMode: "full-access", interactionMode: "plan" },
    ] as const) {
      const narrowed: McpInvocationContext.McpInvocationScope = {
        ...peerSession,
        client: { sessionId: "session-1", label: "machine VPS", access: "auto", narrowedTo },
      };
      const error = yield* exec(narrowed, { machine: SELF, command: "true" }).pipe(Effect.flip);
      expect(error.message).toContain("full-access/default");
    }
    expect(runs).toEqual([]);
    expect(reports).toMatchObject([{ outcome: "refused" }, { outcome: "refused" }]);
  }),
);

it.effect("refuses restricted callers and missing exec before sending anything", () =>
  Effect.gen(function* () {
    const allowed = yield* harness({ desired: desiredState({ arrowsOut: [execArrowOut] }) });
    for (const modes of [{ runtimeMode: "auto" }, { interactionMode: "plan" }] as const) {
      const error = yield* allowed
        .exec(localThread, { machine: "VPS", command: "true" }, modes)
        .pipe(Effect.flip);
      expect(error.message).toContain("full-access/default");
    }
    expect(allowed.requests).toEqual([]);

    const withoutExec = yield* harness({
      desired: desiredState({ arrowsOut: [arrow(SELF, PEER, "admin", { agentTools: true })] }),
    });
    const error = yield* withoutExec
      .exec(localThread, { machine: "VPS", command: "true" })
      .pipe(Effect.flip);
    expect(error.message).toContain("does not allow exec");
    expect(withoutExec.requests).toEqual([]);
    // A refusal on this side never reaches the other machine, so this machine reports it.
    expect([...allowed.reports, ...withoutExec.reports]).toMatchObject([
      { from: SELF, target: PEER, outcome: "refused" },
      { from: SELF, target: PEER, outcome: "refused" },
      { from: SELF, target: PEER, outcome: "refused" },
    ]);
  }),
);

it.effect("a restricted thread's shell is refused with its own thread credential (MM-1920)", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.__testing.make({}).pipe(
      Effect.provideService(
        HttpServer.HttpServer,
        HttpServer.HttpServer.of({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
          serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
        }),
      ),
      Effect.provideService(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(localThread.environmentId),
          getDescriptor: Effect.die("unused"),
        }),
      ),
      Effect.provide(NodeServices.layer),
    );
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    // What `t3 tool call` in the agent's shell presents to `/mcp`.
    const shell = withThreadCredential({}, issued.config);
    const presented = shell.T3_ACP_MCP_AUTHORIZATION?.slice("Bearer ".length) ?? "";
    const scope = yield* registry.resolve(presented);
    if (scope === undefined) return yield* Effect.die("The shell credential does not resolve.");
    expect(scope.thread.threadId).toBe(threadId);

    const allowed = yield* harness({ desired: desiredState({ arrowsOut: [execArrowOut] }) });
    const error = yield* allowed
      .exec(scope, { machine: "VPS", command: "true" }, { runtimeMode: "auto" })
      .pipe(Effect.flip);
    expect(error.message).toContain("full-access/default");
    expect(allowed.requests).toEqual([]);
  }),
);

it.effect.each([
  {
    name: "the emergency pause",
    change: (desired: MachineDesiredState) => ({ ...desired, paused: true }),
  },
  {
    name: "arrow removal",
    change: (desired: MachineDesiredState) => ({ ...desired, arrowsIn: [] }),
  },
])("$name stops a running command at once", ({ change }) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const processRunner = Layer.mock(ProcessRunner.ProcessRunner)({
      run: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
    });
    const desired = desiredState({ arrowsIn: [execArrowIn] });
    const { exec, state, reports } = yield* harness({ desired, processRunner });
    const fiber = yield* exec(peerSession, { machine: SELF, command: "sleep 600" }).pipe(
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* SubscriptionRef.update(state, (local) => ({
      ...local,
      saved: { ...local.saved, desired: change(desired) },
    }));
    const error = yield* Fiber.join(fiber);
    expect(error.message).toContain("stopped the command");
    yield* Deferred.await(interrupted);
    expect(reports.map((report) => report.outcome)).toEqual(["stopped"]);
  }),
);
