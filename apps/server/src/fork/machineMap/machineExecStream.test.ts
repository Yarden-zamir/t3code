// Fork: `t3 machine exec` (MM-1919). The CLI (`runExecClient`) opens A's real stream route with an
// agent thread's MCP credential (MM-1920), and A relays over its arrow to B's real route and auth
// (`servePeer`). Only Cloudflare Access and pairing are faked, as in MachinePeers.test.ts.
// The commands run for real on this machine, as B.
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAccessTokenType,
  EnvironmentId,
  MACHINE_EXEC_STREAM_PATH,
  MACHINE_LEVEL_SCOPES,
  type MachineDesiredState,
  type MachineExecReport,
  type MachineExecStreamStart,
  ProviderInstanceId,
  ThreadId,
  machineSessionSubject,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as Socket from "effect/socket/Socket";

import * as ServerSettings from "../../serverSettings.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { descriptorOf, servePeer } from "../../peer/PeerLinks.testkit.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  CLI_LOCAL_USER_LABEL,
  CLI_LOCAL_USER_REFUSAL,
  MACHINE_MCP_CAPABILITIES,
  machineMcpClientFor,
} from "./machineAccess.ts";
import {
  EXIT_FAILED,
  makeLiveness,
  openExecSocket,
  PING_INTERVAL,
  runExecClient,
  streamUrl,
} from "./machineExecStream.ts";
import * as MachineExec from "./MachineExec.ts";
import * as MachineExecRoute from "./machineExecRoute.ts";
import { arrow, desiredState, PEER, SELF } from "./MachineMap.testkit.ts";
import * as MachineMap from "./MachineMap.ts";
import * as MachineMapState from "./MachineMapState.ts";
import * as MachinePeers from "./MachinePeers.ts";

const vps = descriptorOf("environment-vps", "VPS");
const vpsOrigin = "https://t3-vps.example.com";
const execArrow = arrow(SELF, PEER, "standard", { agentTools: true, exec: true });

const fullThread = ThreadId.make("thread:mac-full");
const restrictedThread = ThreadId.make("thread:mac-restricted");
/** The MCP credentials of agent shells on A, as `McpSessionRegistry` resolves them. */
const shellTokens: Record<string, ThreadId> = {
  "token-full": fullThread,
  "token-restricted": restrictedThread,
};
/** What `t3 machine exec` presents without a thread credential: the local user's session. */
const cliLocalUser: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-mac"),
  requestNamespace: "client:cli-session",
  thread: undefined,
  client: { sessionId: "cli-session", label: CLI_LOCAL_USER_LABEL, access: "full-access" },
  capabilities: new Set(MACHINE_MCP_CAPABILITIES),
  issuedAt: 0,
};

/** B's desired state: A is its peer, with `arrowIn` from A into B. */
const vpsDesired = (input: {
  readonly arrowIn?: typeof execArrow;
  readonly paused?: boolean;
}): MachineDesiredState => {
  const base = desiredState({ arrowsIn: [] });
  return {
    ...base,
    self: { ...base.self, id: PEER, name: "VPS", tokenClientId: "vps-token.access" },
    peers: [
      {
        id: SELF,
        name: "Mac",
        kind: "laptop",
        hostname: "t3-mac.example.com",
        tokenClientId: "mac-token.access",
      },
    ],
    arrowsIn: input.arrowIn === undefined ? [] : [input.arrowIn],
    ...(input.paused === true ? { paused: true } : {}),
  };
};

const localState = (desired: MachineDesiredState): MachineMapState.LocalState => ({
  enabled: true,
  clientAccess: "off",
  portalUrl: "https://portal.example.com",
  token: { clientId: "mac-token.access", secret: "mac-secret" },
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

/** A machine map state on `state`, which also admits machine sessions as the fork does. */
const stateOf = (state: SubscriptionRef.SubscriptionRef<MachineMapState.LocalState>) =>
  Effect.gen(function* () {
    const desired = SubscriptionRef.get(state).pipe(Effect.map((local) => local.saved.desired));
    return MachineMapState.MachineMapState.of({
      clientSeen: yield* Queue.unbounded<never>(),
      snapshot: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
      activeDesired: desired,
      mcpClient: (session: Parameters<typeof machineMcpClientFor>[1]) =>
        desired.pipe(
          Effect.map((current) =>
            current === null ? undefined : machineMcpClientFor(current, session, 0),
          ),
        ),
      lockedFor: () => Effect.succeed(false),
      trustsPeerOrigin: () => false,
      peerOrigins: () => [],
      machineGrant: () => Effect.void,
    } as unknown as MachineMapState.MachineMapState["Service"]);
  });

const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) =>
    Effect.succeed(
      liveThreadShell(
        threadId,
        threadId === restrictedThread
          ? { runtimeMode: "approval-required", interactionMode: "plan" }
          : {},
      ),
    ),
});

const shellScope = (threadId: ThreadId): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment-mac"),
  requestNamespace: `provider-session:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider-session:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(MACHINE_MCP_CAPABILITIES),
  issuedAt: 0,
});

const refusingHttp = HttpClient.make((request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description: "offline" }),
    }),
  ),
);

/** A run of `MachineExec` on one machine, with the reports it sends to the portal. */
const layerExec = (reports: Array<MachineExecReport>, http: Layer.Layer<HttpClient.HttpClient>) =>
  MachineExec.layer.pipe(
    Layer.provide(MachinePeers.layer.pipe(Layer.provide(http))),
    Layer.provide(
      Layer.mock(MachineMap.MachineMap)({
        reportExec: (report) => Effect.sync(() => void reports.push(report)),
      }),
    ),
    Layer.provide(ProcessRunner.layer),
    Layer.provide(NodeServices.layer),
  );

const setup = Effect.gen(function* () {
  const vpsReports: Array<MachineExecReport> = [];
  let pairings = 0;
  const macReports: Array<MachineExecReport> = [];
  const vpsState = yield* SubscriptionRef.make(localState(vpsDesired({ arrowIn: execArrow })));
  const macState = yield* SubscriptionRef.make(
    localState(desiredState({ arrowsOut: [execArrow] })),
  );

  // B: the stream route behind the real MCP auth, on a real socket.
  const vpsPeer = yield* servePeer(
    vps,
    MachineExecRoute.layer.pipe(
      Layer.provide(layerExec(vpsReports, Layer.succeed(HttpClient.HttpClient, refusingHttp))),
      Layer.provide(threads),
      Layer.provide(NodeSocket.layerWebSocketConstructor),
    ),
  ).pipe(Effect.provideService(MachineMapState.MachineMapState, yield* stateOf(vpsState)));

  // Cloudflare Access and B's pairing endpoint become a B session of A's machine subject.
  const network = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const fetchClient = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      return HttpClient.make((request, url) =>
        Effect.gen(function* () {
          if (url.pathname === "/api/auth/cloudflare-access/pairing-credential") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                id: "pairing",
                credential: "pairing-credential",
                expiresAt: "2026-12-01T00:00:00.000Z",
              }),
            );
          }
          if (url.pathname === "/oauth/token") {
            pairings += 1;
            const issued = yield* vpsPeer.auth.issueSession({
              subject: machineSessionSubject(SELF),
              scopes: MACHINE_LEVEL_SCOPES.standard,
              label: "machine Mac",
            });
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                access_token: issued.token,
                issued_token_type: AuthAccessTokenType,
                token_type: "Bearer",
                expires_in: 3600,
                scope: MACHINE_LEVEL_SCOPES.standard.join(" "),
              }),
            );
          }
          return yield* fetchClient.execute(
            HttpClientRequest.setUrl(request, `${vpsPeer.url}${url.pathname}`),
          );
        }).pipe(Effect.orDie),
      );
    }),
  );
  // B's tunnel hostname reaches B's socket.
  const tunnel = Layer.effect(
    Socket.WebSocketConstructor,
    Effect.gen(function* () {
      const open = yield* Socket.WebSocketConstructor;
      const vpsSocket = vpsPeer.url.replace("http://", "ws://");
      return (url: string, options?: Socket.WebSocketConstructorOptions) =>
        open(url.replace(vpsOrigin.replace("https://", "wss://"), vpsSocket), options);
    }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor)),
  );

  // A: the stream route behind the real MCP auth, with the shell credentials of its threads.
  const mac = yield* HttpRouter.serve(
    MachineExecRoute.layer.pipe(
      Layer.provide(layerExec(macReports, network)),
      Layer.provide(Layer.effect(MachineMapState.MachineMapState, stateOf(macState))),
      Layer.provide(
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolve: (token) => {
            const threadId = shellTokens[token];
            return Effect.succeed(threadId === undefined ? undefined : shellScope(threadId));
          },
        }),
      ),
      Layer.provide(
        Layer.succeed(McpHttpServer.McpClientAuthenticator, {
          authenticate: (request) =>
            Effect.succeed(
              request.headers.authorization === "Bearer token-cli" ? cliLocalUser : undefined,
            ),
        }),
      ),
      Layer.provide(threads),
      Layer.provide(tunnel),
      Layer.provide(ServerSettings.layerTest()),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.provideMerge(Layer.fresh(NodeHttpServer.layerTest)), Layer.fresh, Layer.build);
  const address = Context.get(mac, HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");

  /** `t3 machine exec` in the shell of an agent on A. */
  const cli = (input: {
    readonly token: string;
    readonly start: Omit<MachineExecStreamStart, "type">;
    readonly stdin?: Stream.Stream<Uint8Array>;
    readonly onStdout?: (bytes: Uint8Array) => Effect.Effect<void>;
  }) =>
    Effect.gen(function* () {
      const stdout: Array<Uint8Array> = [];
      const stderr: Array<Uint8Array> = [];
      const socket = yield* openExecSocket(
        streamUrl(`http://127.0.0.1:${address.port}`, MACHINE_EXEC_STREAM_PATH),
        { authorization: `Bearer ${input.token}` },
      );
      const result = yield* runExecClient({
        socket,
        start: { type: "start", ...input.start },
        stdin: input.stdin ?? Stream.empty,
        stdout: (bytes) =>
          Effect.sync(() => void stdout.push(bytes)).pipe(
            Effect.andThen(input.onStdout?.(bytes) ?? Effect.void),
          ),
        stderr: (bytes) => Effect.sync(() => void stderr.push(bytes)),
      });
      return { ...result, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    }).pipe(Effect.scoped, Effect.provide(NodeSocket.layerWebSocketConstructor));

  return { cli, vpsPeer, vpsState, vpsReports, macReports, pairings: () => pairings };
});

it.live("a restricted thread is refused, and nothing reaches the other machine", () =>
  Effect.gen(function* () {
    const env = yield* setup;
    const result = yield* env.cli({
      token: "token-restricted",
      start: { machine: "VPS", command: "true" },
    });
    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.message).toContain("full-access/default");
    expect(env.macReports).toMatchObject([
      { from: SELF, target: PEER, threadId: restrictedThread, outcome: "refused" },
    ]);
    expect(env.vpsReports).toEqual([]);
    expect(yield* Ref.get(env.vpsPeer.bearers)).toEqual([]);
    expect(yield* Ref.get(env.vpsPeer.probes)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("the local-user session of the CLI is refused, and nothing reaches the other machine", () =>
  Effect.gen(function* () {
    const env = yield* setup;
    const result = yield* env.cli({
      token: "token-cli",
      start: { machine: "VPS", command: "true" },
    });
    expect(result).toMatchObject({ exitCode: EXIT_FAILED, message: CLI_LOCAL_USER_REFUSAL });
    expect(env.vpsReports).toEqual([]);
    expect(yield* Ref.get(env.vpsPeer.bearers)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("a credential that is no thread's opens nothing", () =>
  Effect.gen(function* () {
    const env = yield* setup;
    const opened = yield* openExecSocket(streamUrl(env.vpsPeer.url, MACHINE_EXEC_STREAM_PATH), {
      authorization: "Bearer not-a-token",
    }).pipe(Effect.scoped, Effect.provide(NodeSocket.layerWebSocketConstructor), Effect.flip);
    expect(opened._tag).toBe("SocketError");
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("keepalive: a stream past 100 seconds stays open while the other end answers", () =>
  Effect.gen(function* () {
    const liveness = yield* makeLiveness;
    let pings = 0;
    // The other end answers each ping, as the frames of a quiet command do through Cloudflare.
    const answered = Effect.sync(() => {
      pings += 1;
    }).pipe(Effect.andThen(liveness.touch));
    const watching = yield* liveness.watch(answered).pipe(Effect.forkChild);
    yield* TestClock.adjust("150 seconds");
    expect(pings).toBe(6);
    expect(watching.pollUnsafe()).toBeUndefined();
    yield* Fiber.interrupt(watching);
  }),
);

it.effect("keepalive: silence ends the stream, but not while this end waits for itself", () =>
  Effect.gen(function* () {
    const silent = yield* makeLiveness;
    const watchingSilent = yield* silent.watch(Effect.void).pipe(Effect.forkChild);
    yield* TestClock.adjust(PING_INTERVAL);
    expect(watchingSilent.pollUnsafe()).toBeUndefined();
    // The first check after 90 silent seconds ends it.
    yield* TestClock.adjust("75 seconds");
    expect(watchingSilent.pollUnsafe()).toBeDefined();

    const waiting = yield* makeLiveness;
    // A command that does not read its stdin holds the other end's frames here.
    yield* waiting.whileWaitingHere(Effect.never).pipe(Effect.forkChild);
    const watchingWaiting = yield* waiting.watch(Effect.void).pipe(Effect.forkChild);
    yield* TestClock.adjust("10 minutes");
    expect(watchingWaiting.pollUnsafe()).toBeUndefined();
    yield* Fiber.interrupt(watchingWaiting);
  }),
);
