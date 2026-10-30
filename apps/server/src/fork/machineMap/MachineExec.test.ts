import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { withThreadCredential } from "@t3tools/provider-core/server/forkThreadCredential";
import {
  EnvironmentId,
  MACHINE_EXEC_MAX_OUTPUT_BYTES,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as NetAddress from "effect/net/NetAddress";
import { HttpServer } from "effect/http";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import type { GrantState } from "../kitshn/kitshnGrantRules.ts";
import { fakeKitshnGrants, peerGrants } from "../kitshn/KitshnGrants.testkit.ts";
import * as KitshnAudit from "../kitshn/KitshnAudit.ts";
import * as KitshnGrants from "../kitshn/KitshnGrants.ts";
import type { LinkAudit } from "../kitshn/kitshnProviderProtocol.ts";
import * as KitshnProvider from "../kitshn/KitshnProvider.ts";
import { machineRequestNamespace } from "./machineAccess.ts";
import * as MachineExec from "./MachineExec.ts";
import { PEER, SELF } from "./MachineMap.testkit.ts";
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

/** This machine reaches PEER: its app card at use and its agents card at `agents`. */
const reachOf = (agents: string) => [
  { machineId: PEER, machineName: "VPS", kind: "t3.app", id: "app", address: null, level: "use" },
  {
    machineId: PEER,
    machineName: "VPS",
    kind: "t3.agents",
    id: "agents",
    address: null,
    level: agents,
  },
];

const harness = Effect.fn("MachineExecTest.harness")(function* (input: {
  readonly reach?: ReadonlyArray<ReturnType<typeof reachOf>[number]>;
  readonly grants?: GrantState;
  readonly processRunner?: Layer.Layer<ProcessRunner.ProcessRunner>;
}) {
  const grantState = yield* SubscriptionRef.make(input.grants ?? peerGrants("standard", "exec"));
  const layerGrants = Layer.succeed(KitshnGrants.KitshnGrants, fakeKitshnGrants(grantState));
  const reports: Array<Omit<LinkAudit, "at">> = [];
  const requests: Array<string> = [];
  const layer = MachineExec.layer.pipe(
    Layer.provide(MachinePeers.layer),
    Layer.provide(layerGrants),
    Layer.provide(
      Layer.mock(KitshnProvider.KitshnProvider)({
        state: Stream.make({
          settings: null,
          cardSettings: {},
          reach: input.reach ?? reachOf("exec"),
        }),
        // The socket path of a test that never opens it: refusals come before any call.
        linkSocket: Effect.succeed("/nonexistent/link.sock"),
        linkSocketFailed: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(KitshnAudit.KitshnAudit)({
        report: (audit) => Effect.sync(() => void reports.push(audit)),
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
  return { grantState, reports, requests, exec };
});

it.live("runs a command for a peer whose grants allow exec, and leaves the audit to it", () =>
  Effect.gen(function* () {
    const { exec, reports } = yield* harness({});
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
    // K-1610: the calling machine reports the run, so this machine reports nothing.
    expect(reports).toEqual([]);
  }),
);

it.live("caps each stream and marks the cut", () =>
  Effect.gen(function* () {
    const { exec } = yield* harness({});
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
    const { exec } = yield* harness({});
    const result = yield* exec(peerSession, {
      machine: SELF,
      command: "sleep 30",
      timeoutSeconds: 1,
    });
    expect(result).toMatchObject({ outcome: "timedOut", exitCode: null });
  }),
);

it.effect("refuses a peer without exec grants, and a call meant for another machine", () =>
  Effect.gen(function* () {
    const runs: Array<string> = [];
    const processRunner = Layer.mock(ProcessRunner.ProcessRunner)({
      run: (input) =>
        Effect.sync(() => void runs.push(input.command)).pipe(Effect.andThen(Effect.never)),
    });
    for (const grants of [
      peerGrants("standard", "use"),
      peerGrants("read", "exec"),
      peerGrants(null, "exec"),
      { ...peerGrants("admin", "exec"), lastContactAt: null },
    ]) {
      const { exec } = yield* harness({ grants, processRunner });
      const error = yield* exec(peerSession, { machine: SELF, command: "true" }).pipe(Effect.flip);
      expect(error.message).toContain("do not allow exec");
    }
    const { exec } = yield* harness({ processRunner });
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
    // K-1610: the calling machine reports; this machine, the target, reports nothing.
    expect(reports).toEqual([]);
  }),
);

it.effect("refuses restricted callers and missing exec before sending anything", () =>
  Effect.gen(function* () {
    const allowed = yield* harness({});
    for (const modes of [{ runtimeMode: "auto" }, { interactionMode: "plan" }] as const) {
      const error = yield* allowed
        .exec(localThread, { machine: "VPS", command: "true" }, modes)
        .pipe(Effect.flip);
      expect(error.message).toContain("full-access/default");
    }
    expect(allowed.requests).toEqual([]);

    const withoutExec = yield* harness({ reach: reachOf("use") });
    const error = yield* withoutExec
      .exec(localThread, { machine: "VPS", command: "true" })
      .pipe(Effect.flip);
    expect(error.message).toContain("does not allow exec");
    expect(withoutExec.requests).toEqual([]);
    // K-1610: this machine reports each refused run, with the first word of the command.
    expect([...allowed.reports, ...withoutExec.reports]).toMatchObject([
      { kind: "exec", target: PEER, name: "true", outcome: "refused", exitCode: null },
      { kind: "exec", target: PEER, name: "true", outcome: "refused", exitCode: null },
      { kind: "exec", target: PEER, name: "true", outcome: "refused", exitCode: null },
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

    const allowed = yield* harness({});
    const error = yield* allowed
      .exec(scope, { machine: "VPS", command: "true" }, { runtimeMode: "auto" })
      .pipe(Effect.flip);
    expect(error.message).toContain("full-access/default");
    expect(allowed.requests).toEqual([]);
  }),
);

it.effect("kitshn's emergency pause refuses a call to another machine (K-1618)", () =>
  Effect.gen(function* () {
    // A pause closes every grant, also the Owner share of the T3 card.
    const paused = yield* harness({ grants: { tables: {}, lastContactAt: 1 } });
    const error = yield* paused
      .exec(localThread, { machine: "VPS", command: "true" })
      .pipe(Effect.flip);
    expect(error.message).toContain("emergency pause");
    expect(paused.requests).toEqual([]);
  }),
);

it.effect("losing the exec grant stops a running command at once", () =>
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
    const { exec, grantState } = yield* harness({ processRunner });
    const fiber = yield* exec(peerSession, { machine: SELF, command: "sleep 600" }).pipe(
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* SubscriptionRef.set(grantState, peerGrants("standard", "use"));
    const error = yield* Fiber.join(fiber);
    expect(error.message).toContain("stopped the command");
    yield* Deferred.await(interrupted);
  }),
);
