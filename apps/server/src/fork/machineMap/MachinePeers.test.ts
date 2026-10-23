// Fork: machine map links (MM-1921). Machine A ("mac") reaches machine B ("vps") over the arrow
// from A to B. B is a real T3 `/mcp` with real session auth (upstream's `servePeer`), which admits
// a machine session the way the fork does (`machineMcpClientFor`). Only the Cloudflare Access
// pairing exchange is faked: it mints a B session with the scopes of the arrow level.
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  type ArrowRecord,
  CommandId,
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  type MachineCallReport,
  type MachineDesiredState,
  MACHINE_LEVEL_SCOPES,
  MachineId,
  type MachineLevel,
  MessageId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  machineSessionSubject,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { McpSchema, McpServer } from "effect/ai";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import { descriptorOf, servePeer, type ServedPeer } from "../../peer/PeerLinks.testkit.ts";
import * as RemoteDelegation from "../../peer/RemoteDelegation.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlRepositoryService from "../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import {
  CLI_LOCAL_USER_LABEL,
  CLI_LOCAL_USER_REFUSAL,
  machineMcpClientFor,
  MANUAL_LINK_REFUSAL,
} from "./machineAccess.ts";
import * as MachineCallHistory from "./MachineCallHistory.ts";
import * as MachineMap from "./MachineMap.ts";
import { arrow, desiredState, PEER, SELF } from "./MachineMap.testkit.ts";
import * as MachineMapState from "./MachineMapState.ts";
import * as MachinePeers from "./MachinePeers.ts";

const mac = descriptorOf("environment-mac", "Mac");
const vps = descriptorOf("environment-vps", "VPS");
const vpsOrigin = "https://t3-vps.example.com";
const vpsProject = ProjectId.make("project:vps");

/** What the test changes on the map: the arrow from A to B, and the pause. */
interface MapNow {
  readonly level: MachineLevel;
  readonly agentTools: boolean;
  readonly paused: boolean;
  /** The tunnel hostname that the portal gives B. */
  readonly vpsHostname?: string;
  /** A third machine with an arrow from A, which never answers. */
  readonly offlinePeer?: boolean;
}

const offline = MachineId.make("offline");

const arrowNow = (map: MapNow): ReadonlyArray<ArrowRecord> => [
  arrow(SELF, PEER, map.level, { agentTools: map.agentTools }),
  ...(map.offlinePeer === true ? [arrow(SELF, offline, "admin", { agentTools: true })] : []),
];

/** B's desired state: A is its peer, with the same arrow into B. */
const desiredOnVps = (map: MapNow): MachineDesiredState => {
  const onMac = desiredState({ arrowsIn: [] });
  return {
    ...onMac,
    self: { ...onMac.self, id: PEER, name: "VPS", tokenClientId: "vps-token.access" },
    peers: [
      {
        id: SELF,
        name: "Mac",
        kind: "laptop",
        hostname: "t3-mac.example.com",
        tokenClientId: "mac-token.access",
      },
    ],
    arrowsIn: arrowNow(map),
    arrowsOut: [],
  };
};

/** What B's services were asked to do. */
interface Seen {
  readonly launches: ReadonlyArray<ThreadLaunch.ThreadLaunchInput>;
  readonly projectUpdates: number;
}

/** The one run of each thread that B launches. The test ends it with `finished`. */
interface VpsRun {
  readonly finished: Deferred.Deferred<void>;
}

const vpsRunId = RunId.make("run:vps");
const vpsReply = "All 412 tests pass on the VPS.";

/** B's threads: those its launches made, each with one run that ends with `vpsReply`. */
const vpsThreads = (seen: Ref.Ref<Seen>, vpsRun: VpsRun) => {
  const shellOf = (threadId: ThreadId) =>
    Ref.get(seen).pipe(
      Effect.map((current) => {
        const launch = current.launches.find((candidate) => candidate.threadId === threadId);
        return launch === undefined
          ? null
          : {
              ...liveThreadShell(threadId, {
                runtimeMode: launch.runtimeMode,
                interactionMode: launch.interactionMode,
              }),
              projectId: vpsProject,
              ...(launch.linkOrigin === undefined ? {} : { linkOrigin: launch.linkOrigin }),
            };
      }),
    );
  const runNow = Deferred.isDone(vpsRun.finished).pipe(
    Effect.map(
      (done) =>
        ({
          id: vpsRunId,
          threadId: ThreadId.make("thread:vps"),
          ordinal: 1,
          status: done ? "completed" : "running",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          requestedAt: DateTime.makeUnsafe(0),
          startedAt: DateTime.makeUnsafe(0),
          completedAt: null,
        }) as unknown as OrchestrationV2Run,
    ),
  );
  const projectionOf = (threadId: ThreadId) =>
    Effect.all([shellOf(threadId), runNow]).pipe(
      Effect.map(([shell, run]) =>
        shell === null ? (null as never) : { ...idleThreadProjection(shell), runs: [run] },
      ),
    );
  return Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: shellOf,
    getProjectThreadRecords: (input) => projectionOf(input.threadId),
    getThreadRecords: (threadId) => projectionOf(threadId),
    waitForThread: (input) =>
      Deferred.await(vpsRun.finished).pipe(
        Effect.timeoutOption(input.timeoutMs),
        Effect.flatMap((done) =>
          runNow.pipe(
            Effect.map((run) => ({ threadId: input.threadId, run, timedOut: Option.isNone(done) })),
          ),
        ),
      ),
    getTimelinePage: (threadId, options) =>
      Effect.succeed({
        items:
          options.view === "activity" || (options.afterPosition ?? -1) >= 0
            ? []
            : [
                {
                  position: 0,
                  visibility: "local" as const,
                  sourceThreadId: threadId,
                  sourceItemId: TurnItemId.make("item:reply"),
                  item: {
                    id: TurnItemId.make("item:reply"),
                    threadId,
                    runId: vpsRunId,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1,
                    status: "completed" as const,
                    title: null,
                    startedAt: DateTime.makeUnsafe(0),
                    completedAt: DateTime.makeUnsafe(0),
                    updatedAt: DateTime.makeUnsafe(0),
                    type: "assistant_message" as const,
                    messageId: MessageId.make("message:reply"),
                    text: vpsReply,
                    streaming: false,
                  } as never,
                },
              ],
        totalItems: 1,
        hasMore: false,
      }),
  });
};

const vpsLaunches = (seen: Ref.Ref<Seen>) =>
  Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Ref.update(seen, (current) => ({ ...current, launches: [...current.launches, input] })).pipe(
        Effect.as({
          threadId: input.threadId,
          projection: {
            thread: {
              id: input.threadId,
              projectId: input.projectId,
              modelSelection: input.modelSelection,
              title: input.title,
            },
            runs:
              input.initialMessage?.messageId === undefined
                ? []
                : [
                    {
                      id: vpsRunId,
                      status: "running",
                      userMessageId: input.initialMessage.messageId,
                    },
                  ],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult),
      ),
  });

const vpsProjects = (seen: Ref.Ref<Seen>) =>
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeed(Option.none()),
    listPage: () => Effect.succeed({ projects: [], nextCursor: null }),
    update: () =>
      Ref.update(seen, (current) => ({
        ...current,
        projectUpdates: current.projectUpdates + 1,
      })).pipe(Effect.andThen(Effect.die("The project update should be refused before it runs."))),
  });

/**
 * B: the orchestrator and project toolkits on its real `/mcp`. Its machine map state admits a
 * session of A as the fork does, from the map that `mapNow` holds.
 */
const serveVps = (seen: Ref.Ref<Seen>, mapNow: Ref.Ref<MapNow>, vpsRun: VpsRun) =>
  servePeer(
    vps,
    Layer.mergeAll(
      McpHttpServer.layerOrchestratorToolkit,
      McpHttpServer.layerProjectRegistration,
      McpHttpServer.layerThreadToolkit,
    ).pipe(
      Layer.provide(NodeCrypto.layer),
      Layer.provide(vpsThreads(seen, vpsRun)),
      Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
      Layer.provide(vpsLaunches(seen)),
      Layer.provide(
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(vpsProjects(seen)),
      Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-machine-links-vps-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
      Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
    ),
  ).pipe(
    Effect.provideService(
      MachineMapState.MachineMapState,
      MachineMapState.MachineMapState.of({
        mcpClient: (session: Parameters<typeof machineMcpClientFor>[1]) =>
          Ref.get(mapNow).pipe(
            Effect.map((map) => machineMcpClientFor(desiredOnVps(map), session, 0)),
          ),
        lockedFor: () => Effect.succeed(false),
        trustsPeerOrigin: () => false,
        machineGrant: () => Effect.succeed(undefined),
      } as unknown as MachineMapState.MachineMapState["Service"]),
    ),
  );

/** What A's link client sent: each pairing, and every request to B with its Access headers. */
interface Wire {
  readonly pairings: number;
  readonly requests: ReadonlyArray<{ readonly path: string; readonly accessClientId: string }>;
}

/**
 * The network between A and B. Cloudflare Access and B's pairing endpoint become a B session of
 * A's machine subject, with the scopes of the arrow level; every other request goes to B.
 */
const layerNetwork = (vpsPeer: ServedPeer, mapNow: Ref.Ref<MapNow>, wire: Ref.Ref<Wire>) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const fetchClient = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      return HttpClient.make((request, url) =>
        Effect.gen(function* () {
          // B answers at each hostname the portal gives it; any other machine is offline.
          if (!url.hostname.startsWith("t3-vps")) {
            return yield* new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: "offline" }),
            });
          }
          yield* Ref.update(wire, (current) => ({
            ...current,
            requests: [
              ...current.requests,
              {
                path: url.pathname,
                accessClientId: request.headers["cf-access-client-id"] ?? "",
              },
            ],
          }));
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
            yield* Ref.update(wire, (current) => ({ ...current, pairings: current.pairings + 1 }));
            const { level } = yield* Ref.get(mapNow);
            const issued = yield* vpsPeer.auth
              .issueSession({
                subject: machineSessionSubject(SELF),
                scopes: MACHINE_LEVEL_SCOPES[level],
                label: "machine Mac",
              })
              .pipe(Effect.orDie);
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                access_token: issued.token,
                issued_token_type: AuthAccessTokenType,
                token_type: "Bearer",
                expires_in: 3600,
                scope: MACHINE_LEVEL_SCOPES[level].join(" "),
              }),
            );
          }
          return yield* fetchClient
            .execute(
              HttpClientRequest.setUrl(request, `${vpsPeer.url}${url.pathname}${url.search}`),
            )
            .pipe(Effect.orDie);
        }),
      );
    }),
  );

/**
 * A's machine map: on the map with its token, and the arrow and pause that `mapNow` holds.
 * `pausedLook` completes when A reads its map while paused.
 */
const layerMacState = (mapNow: Ref.Ref<MapNow>, pausedLook: Deferred.Deferred<void>) =>
  Layer.effect(
    MachineMapState.MachineMapState,
    Effect.gen(function* () {
      const clientSeen = yield* Queue.unbounded<never>();
      return MachineMapState.MachineMapState.of({
        clientSeen,
        snapshot: Ref.get(mapNow).pipe(
          Effect.tap((map) => (map.paused ? Deferred.succeed(pausedLook, undefined) : Effect.void)),
          Effect.map((map) => ({
            enabled: true,
            clientAccess: "off" as const,
            portalUrl: "https://portal.example.com",
            token: { clientId: "mac-token.access", secret: "mac-secret" },
            saved: {
              // The pause sets every arrow to `none` and says `paused` (MM-710, MM-718).
              desired: {
                ...desiredState({
                  arrowsOut: arrowNow(map.paused ? { ...map, level: "none" } : map),
                  paused: map.paused,
                }),
                peers: [
                  {
                    id: PEER,
                    name: "VPS",
                    kind: "server" as const,
                    hostname: map.vpsHostname ?? "t3-vps.example.com",
                    tokenClientId: "vps-token.access",
                  },
                  {
                    id: offline,
                    name: "Offline",
                    kind: "server" as const,
                    hostname: "t3-offline.example.com",
                    tokenClientId: "offline-token.access",
                  },
                ],
              },
              desiredAtMs: 0,
              handledCommandIds: [],
              pausedTaskIds: [],
              desktopCommands: [],
              pendingRevokes: [],
              pendingClientAccess: null,
            },
          })),
        ),
      } as unknown as MachineMapState.MachineMapState["Service"]);
    }),
  );

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "machine-links-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "machine-links-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** The thread on A that calls; its modes come from its name. */
const callerModes = (threadId: ThreadId) =>
  threadId === ThreadId.make("thread:mac-restricted")
    ? ({ runtimeMode: "approval-required", interactionMode: "plan" } as const)
    : ({ runtimeMode: "full-access", interactionMode: "default" } as const);

/**
 * A: its orchestrator and project toolkits with upstream forwarding over the arrow links of
 * `MachinePeers`, which reports each forwarded call to the portal History (MM-1922). Its own
 * threads never matter here, only the modes of the caller.
 */
const makeMac = (
  mapNow: Ref.Ref<MapNow>,
  pausedLook: Deferred.Deferred<void>,
  network: Layer.Layer<HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const reportedCalls = yield* Ref.make<ReadonlyArray<MachineCallReport>>([]);
    const links = yield* MachinePeers.layer.pipe(
      Layer.provide(layerMacState(mapNow, pausedLook)),
      Layer.provide(network),
      // Fresh: layers are memoized across tests, and each test has its own machines.
      Layer.fresh,
      Layer.build,
    );
    const layerHere = Layer.mergeAll(
      McpHttpServer.layerOrchestratorToolkit,
      McpHttpServer.layerProjectRegistration,
      McpHttpServer.layerThreadToolkit,
    ).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
      Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
      Layer.provide(
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-machine-links-mac-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        MachineCallHistory.layer.pipe(
          Layer.provide(
            Layer.mock(MachineMap.MachineMap)({
              reportCall: (report) => Ref.update(reportedCalls, (calls) => [...calls, report]),
            }),
          ),
        ),
      ),
      Layer.provide(Layer.succeedContext(links)),
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(liveThreadShell(threadId, callerModes(threadId))),
          getProjectThreadRecords: ({ threadId }) =>
            Effect.succeed({ thread: liveThreadShell(threadId, callerModes(threadId)) } as never),
        }),
      ),
      Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      Layer.fresh,
    );
    const here = yield* Layer.build(layerHere);
    const server = Context.get(here, McpServer.McpServer);
    const call = (caller: string, name: string, args: Record<string, unknown>) =>
      server.callTool({ name, arguments: args }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: mac.environmentId,
          requestNamespace: `provider-session:${caller}`,
          thread: {
            threadId: ThreadId.make(caller),
            providerSessionId: `provider-session:${caller}`,
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
          issuedAt: 1,
        }),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
    return { links: Context.get(links, PeerLinks.PeerLinks), call, reportedCalls };
  });

const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text"
    ? (JSON.parse(text.text) as { readonly code: string; readonly message: string })
    : undefined;
};

const setup = (initial: MapNow) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<Seen>({ launches: [], projectUpdates: 0 });
    // Each machine applies a portal revision on its own, so A and B can see different maps.
    const mapNow = yield* Ref.make(initial);
    const vpsMap = yield* Ref.make(initial);
    const wire = yield* Ref.make<Wire>({ pairings: 0, requests: [] });
    const vpsRun: VpsRun = { finished: yield* Deferred.make<void>() };
    const pausedLook = yield* Deferred.make<void>();
    const vpsPeer = yield* serveVps(seen, vpsMap, vpsRun);
    const mac = yield* makeMac(mapNow, pausedLook, layerNetwork(vpsPeer, vpsMap, wire));
    return { ...mac, seen, mapNow, vpsMap, wire, vpsPeer, vpsRun, pausedLook };
  });

const launchOnVps = (caller: string) => ({
  environmentId: vps.environmentId,
  projectId: vpsProject,
  title: `Launched by ${caller}`,
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  message: "Run the suite there.",
});

it.effect("a standard arrow is a linked environment fenced to auto", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ level: "standard", agentTools: true, paused: false });
      const listed = yield* env.call("thread:mac-full", "t3_environment_links", {});
      expect(listed.structuredContent).toMatchObject({
        links: [
          { environmentId: vps.environmentId, label: "VPS", status: "reachable", access: "auto" },
        ],
      });

      const launched = yield* env.call(
        "thread:mac-full",
        "t3_thread_launch",
        launchOnVps("thread:mac-full"),
      );
      expect(launched.isError, JSON.stringify(launched.content)).toBe(false);
      // A full-access thread here gets the link's `auto` there, and its work carries the link
      // of the machine, not of the session, so it stays the machine's own across a re-pair.
      expect((yield* Ref.get(env.seen)).launches).toMatchObject([
        {
          runtimeMode: "auto",
          linkOrigin: { sessionId: machineSessionSubject(SELF), access: "auto" },
        },
      ]);

      // Fenced work changes nothing that B already had.
      const updated = yield* env.call("thread:mac-full", "t3_project_update", {
        environmentId: vps.environmentId,
        projectId: vpsProject,
        title: "Renamed from the Mac",
      });
      expect(failureOf(updated)?.message).toContain("cannot change projects");
      expect((yield* Ref.get(env.seen)).projectUpdates).toBe(0);

      // Every request to B carries the machine token for Cloudflare Access.
      const wire = yield* Ref.get(env.wire);
      expect(wire.requests.length).toBeGreaterThan(0);
      expect(wire.requests.every((request) => request.accessClientId === "mac-token.access")).toBe(
        true,
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("each forwarded call goes to History, never with its arguments", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ level: "standard", agentTools: true, paused: false });
      yield* env.call("thread:mac-full", "t3_thread_launch", launchOnVps("thread:mac-full"));
      yield* env.call("thread:mac-full", "t3_project_update", {
        environmentId: vps.environmentId,
        projectId: vpsProject,
        title: "Renamed from the Mac",
      });
      const reported = yield* Ref.get(env.reportedCalls);
      expect(reported.map(({ id: _id, at: _at, ...call }) => call)).toEqual([
        {
          to: PEER,
          threadId: "thread:mac-full",
          threadTitle: "thread:mac-full",
          tool: "t3_thread_launch",
          outcome: "succeeded",
        },
        {
          to: PEER,
          threadId: "thread:mac-full",
          threadTitle: "thread:mac-full",
          tool: "t3_project_update",
          outcome: "refused",
        },
      ]);
      const text = JSON.stringify(reported);
      expect(text).not.toContain("Run the suite there");
      expect(text).not.toContain("Renamed from the Mac");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a restricted thread reaches B with its own limits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ level: "admin", agentTools: true, paused: false });
      const launched = yield* env.call(
        "thread:mac-restricted",
        "t3_thread_launch",
        launchOnVps("thread:mac-restricted"),
      );
      expect(launched.isError, JSON.stringify(launched.content)).toBe(false);
      // `T3-Mode-Limit` narrows the admin link to the caller's approval-required plan mode.
      expect((yield* Ref.get(env.seen)).launches).toMatchObject([
        { runtimeMode: "approval-required", interactionMode: "plan" },
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("an arrow without agent tools is no link, and nothing goes to B", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ level: "admin", agentTools: false, paused: false });
      const read = yield* env.call("thread:mac-full", "t3_project_list", {
        environmentId: vps.environmentId,
      });
      expect(failureOf(read)?.message).toContain("Set the arrow in the portal");
      expect((yield* Ref.get(env.wire)).requests).toEqual([]);
      expect(yield* env.links.list).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("the pause holds a link without dropping it, and resume lets work go on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ level: "admin", agentTools: true, paused: false });
      const before = yield* env.call("thread:mac-full", "t3_project_list", {
        environmentId: vps.environmentId,
      });
      expect(before.isError, JSON.stringify(before.content)).toBe(false);

      yield* Ref.update(env.mapNow, (map) => ({ ...map, paused: true }));
      const requestsBefore = (yield* Ref.get(env.wire)).requests.length;
      const paused = yield* env.call("thread:mac-full", "t3_project_list", {
        environmentId: vps.environmentId,
      });
      // `orchestration_error` is what remote delegation retries; a final refusal is not.
      expect(failureOf(paused)).toMatchObject({ code: "orchestration_error" });
      expect(failureOf(paused)?.message).toContain("paused");
      expect((yield* Ref.get(env.wire)).requests).toHaveLength(requestsBefore);
      // The link stays known, so a task that waits on it is not failed as unknown.
      expect(Option.isSome(yield* env.links.get(vps.environmentId))).toBe(true);

      yield* Ref.update(env.mapNow, (map) => ({ ...map, paused: false }));
      const resumed = yield* env.call("thread:mac-full", "t3_project_list", {
        environmentId: vps.environmentId,
      });
      expect(resumed.isError, JSON.stringify(resumed.content)).toBe(false);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a removed arrow makes the link unknown, with the reason", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ level: "admin", agentTools: true, paused: false });
      yield* env.call("thread:mac-full", "t3_environment_links", {});
      yield* Ref.update(env.mapNow, (map) => ({ ...map, level: "none" as const }));
      const read = yield* env.call("thread:mac-full", "t3_project_list", {
        environmentId: vps.environmentId,
      });
      // `invalid_request` with no link here is what remote delegation fails a task with.
      expect(failureOf(read)).toMatchObject({ code: "invalid_request" });
      expect(failureOf(read)?.message).toContain("Set the arrow in the portal");
      expect(Option.isNone(yield* env.links.get(vps.environmentId))).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a removed arrow is unknown, also while another machine with an arrow is offline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({
        level: "admin",
        agentTools: true,
        paused: false,
        offlinePeer: true,
      });
      const first = yield* env.call("thread:mac-full", "t3_project_list", {
        environmentId: vps.environmentId,
      });
      expect(first.isError, JSON.stringify(first.content)).toBe(false);
      yield* Ref.update(env.mapNow, (map) => ({ ...map, level: "none" as const }));
      const removed = yield* env.call("thread:mac-full", "t3_project_list", {
        environmentId: vps.environmentId,
      });
      expect(failureOf(removed)).toMatchObject({ code: "invalid_request" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a new hostname of B gets its own pairing, never the old session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ level: "admin", agentTools: true, paused: false });
      yield* env.call("thread:mac-full", "t3_project_list", { environmentId: vps.environmentId });
      yield* Ref.update(env.mapNow, (map) => ({ ...map, vpsHostname: "t3-vps-new.example.com" }));
      const moved = yield* env.call("thread:mac-full", "t3_project_list", {
        environmentId: vps.environmentId,
      });
      expect(moved.isError, JSON.stringify(moved.content)).toBe(false);
      const wire = yield* Ref.get(env.wire);
      expect(wire.pairings).toBe(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a known machine at a new hostname that does not answer yet is unreachable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ level: "admin", agentTools: true, paused: false });
      yield* env.call("thread:mac-full", "t3_project_list", { environmentId: vps.environmentId });
      yield* Ref.update(env.mapNow, (map) => ({ ...map, vpsHostname: "t3-moved.example.com" }));
      const moved = yield* env.call("thread:mac-full", "t3_project_list", {
        environmentId: vps.environmentId,
      });
      // The arrow is still there, so remote tasks wait instead of failing.
      expect(failureOf(moved)).toMatchObject({ code: "orchestration_error" });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a link that B refuses before A sees the change fails as unreachable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ level: "admin", agentTools: true, paused: false });
      yield* env.call("thread:mac-full", "t3_environment_links", {});
      yield* Ref.update(env.vpsMap, (map) => ({ ...map, agentTools: false }));
      const listed = yield* env.call("thread:mac-full", "t3_project_list", {
        environmentId: vps.environmentId,
      });
      // Not upstream's final "link revoked": A's own map says what changed on its next look.
      expect(failureOf(listed)).toMatchObject({ code: "orchestration_error" });
      expect((yield* Ref.get(env.wire)).pairings).toBe(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a session that B ended pairs again once, and the call goes through", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ level: "admin", agentTools: true, paused: false });
      const first = yield* env.call("thread:mac-full", "t3_project_list", {
        environmentId: vps.environmentId,
      });
      expect(first.isError, JSON.stringify(first.content)).toBe(false);
      expect((yield* Ref.get(env.wire)).pairings).toBe(1);

      // MM-1306: a level change on B ends every session of A there.
      for (const session of yield* env.vpsPeer.auth.listSessions().pipe(Effect.orDie)) {
        yield* env.vpsPeer.auth.revokeSession(session.sessionId).pipe(Effect.orDie);
      }
      const again = yield* env.call("thread:mac-full", "t3_project_list", {
        environmentId: vps.environmentId,
      });
      expect(again.isError, JSON.stringify(again.content)).toBe(false);
      expect((yield* Ref.get(env.wire)).pairings).toBe(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("the local-user session of the CLI reaches no other machine (MM-1920)", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ level: "admin", agentTools: true, paused: false });
      const refused = yield* env.links.resolve(vps.environmentId).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: mac.environmentId,
          requestNamespace: "client:cli-session",
          thread: undefined,
          client: { sessionId: "cli-session", label: CLI_LOCAL_USER_LABEL, access: "full-access" },
          capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
          issuedAt: 1,
        }),
        Effect.flip,
      );
      expect(refused.message).toBe(CLI_LOCAL_USER_REFUSAL);
      expect((yield* Ref.get(env.wire)).pairings).toBe(0);
      // The list of links stays readable: it is local.
      const listed = yield* env.call("thread:mac-full", "t3_environment_links", {});
      expect(listed.isError).toBe(false);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses manual links: they come from the arrows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ level: "admin", agentTools: true, paused: false });
      const linked = yield* env.links
        .link({ url: vpsOrigin, pairingCode: "code", access: "full-access" })
        .pipe(Effect.flip);
      const unlinked = yield* env.links.unlink(vps.environmentId).pipe(Effect.flip);
      expect([linked.message, unlinked.message]).toEqual([
        MANUAL_LINK_REFUSAL,
        MANUAL_LINK_REFUSAL,
      ]);
      expect((yield* Ref.get(env.wire)).requests).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

// Delegation: A's real orchestrator with remote delegation over the arrow link, as in upstream's
// `RemoteDelegation.test.ts`, which fork runs skip (`src/fork/excludedUpstreamTests.ts`).

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const parentThreadId = ThreadId.make("thread:mac-parent");
const parentRunId = RunId.make("run:mac-parent");
const parentRootNode = NodeId.make("node:mac-parent:root");
const parentScope: McpInvocationContext.McpInvocationScope = {
  environmentId: mac.environmentId,
  requestNamespace: "provider-session:mac-parent",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:mac-parent",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** A with its orchestrator, its parent thread mid-turn, and remote delegation over the links. */
const setupDelegation = (initial: MapNow) =>
  Effect.gen(function* () {
    const env = yield* setup(initial);
    const offers = yield* SubscriptionRef.make<
      ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
    >([]);
    const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
    const layerDatabase = Layer.succeedContext(database);
    const links = yield* MachinePeers.layer.pipe(
      Layer.provide(layerMacState(env.mapNow, env.pausedLook)),
      Layer.provide(layerNetwork(env.vpsPeer, env.vpsMap, env.wire)),
      Layer.merge(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(mac.environmentId),
          getDescriptor: Effect.succeed(mac),
        }),
      ),
      Layer.fresh,
      Layer.build,
    );
    const layerOrchestrator = Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "machine-links-mac" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ).pipe(
      Layer.provide(
        Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: (request) => SubscriptionRef.update(offers, (seen) => [...seen, request]),
          take: Effect.never,
        }),
      ),
    );
    const layerThreads = ThreadManagement.layer.pipe(
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
      Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
    );
    const here = yield* McpHttpServer.layerOrchestratorToolkit.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(
        RemoteDelegation.layer.pipe(
          Layer.provideMerge(PeerForwarding.layer),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({})),
        ),
      ),
      Layer.provide(Layer.succeedContext(links)),
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(layerThreads),
      Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.fresh,
      Layer.build,
    );
    const server = Context.get(here, McpServer.McpServer);
    const orchestrator = Context.get(here, Orchestrator.OrchestratorV2);
    const sink = Context.get(here, EventSink.EventSinkV2);
    yield* seedParent(orchestrator, sink);
    const delegate = server
      .callTool({
        name: "delegate_task",
        arguments: {
          task: "Run the full suite on the VPS.",
          target: {
            environmentId: vps.environmentId,
            providerInstanceId: instanceId,
            model: "gpt-5.4",
            projectId: vpsProject,
          },
          mode: "async",
          clientRequestId: "suite-on-vps",
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, parentScope),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
        Effect.map((result) => {
          expect(result.isError, JSON.stringify(result.content)).toBe(false);
          return result.structuredContent as { readonly taskId: NodeId };
        }),
      );
    /** The task once it has its result here. */
    const taskResult = (taskId: NodeId) =>
      orchestrator
        .streamStoredEventsFrom({
          threadId: parentThreadId,
          afterSequence: 0,
          eventType: "subagent.updated",
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === taskId &&
              stored.event.payload.result !== null,
          ),
          Stream.runHead,
          Effect.map((stored) =>
            Option.isSome(stored) && stored.value.event.type === "subagent.updated"
              ? stored.value.event.payload
              : undefined,
          ),
        );
    return { ...env, offers, orchestrator, delegate, taskResult };
  });

/** A's parent thread, mid-turn when its agent delegates. */
const seedParent = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  sink: EventSink.EventSinkV2["Service"],
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make("provider-thread:mac-parent");
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:create:mac-parent"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:mac"),
      title: "Mac parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* sink.write({
      commandId: CommandId.make("command:seed:mac-parent"),
      events: [
        {
          id: EventId.make("event:seed-provider-thread:mac-parent"),
          type: "provider-thread.updated",
          threadId: parentThreadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: parentThreadId,
            ownerNodeId: parentRootNode,
            nativeThreadRef: { driver, nativeId: "native:mac-parent", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("event:seed-node:mac-parent"),
          type: "node.updated",
          threadId: parentThreadId,
          runId: parentRunId,
          nodeId: parentRootNode,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: parentRootNode,
            threadId: parentThreadId,
            runId: parentRunId,
            parentNodeId: null,
            rootNodeId: parentRootNode,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make("event:seed-run:mac-parent"),
          type: "run.updated",
          threadId: parentThreadId,
          runId: parentRunId,
          nodeId: parentRootNode,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: parentRunId,
            threadId: parentThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make("message:seed-user:mac-parent"),
            rootNodeId: parentRootNode,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
  });

it.effect("a task delegated to B over the arrow link wakes A's parent once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setupDelegation({ level: "standard", agentTools: true, paused: false });
      const delegated = yield* env.delegate;
      // A retry with the same key records nothing new here, and B gets the same command,
      // which its command receipts answer once.
      expect((yield* env.delegate).taskId).toBe(delegated.taskId);
      const launches = (yield* Ref.get(env.seen)).launches;
      expect(new Set(launches.map((launch) => launch.commandId)).size).toBe(1);

      yield* Deferred.succeed(env.vpsRun.finished, undefined);
      expect(yield* env.taskResult(delegated.taskId)).toMatchObject({
        status: "completed",
        result: vpsReply,
      });
      const parent = yield* env.orchestrator.getThreadProjection(parentThreadId);
      expect(parent.subagents).toHaveLength(1);
      expect(
        parent.runs.find((run) => run.id === parentRunId)?.delegatedCompletion?.delivery?.taskIds,
      ).toEqual([delegated.taskId]);
      const offered = yield* SubscriptionRef.changes(env.offers).pipe(
        Stream.filter((seen) => seen.some((offer) => offer.threadId === parentThreadId)),
        Stream.runHead,
      );
      expect(
        Option.getOrThrow(offered).filter((offer) => offer.threadId === parentThreadId),
      ).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("a removed arrow fails A's open task with the reason", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setupDelegation({ level: "standard", agentTools: true, paused: false });
      const delegated = yield* env.delegate;
      yield* Ref.update(env.mapNow, (map) => ({ ...map, level: "none" as const }));
      yield* Deferred.succeed(env.vpsRun.finished, undefined);
      const task = yield* env.taskResult(delegated.taskId);
      expect(task?.status).toBe("failed");
      expect(task?.result).toContain("Set the arrow in the portal");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

// Live: the follower backs off for 2 seconds after the paused look, and a test clock cannot know
// when that wait starts.
it.live("the pause holds A's open task, and resume completes it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setupDelegation({ level: "standard", agentTools: true, paused: false });
      const delegated = yield* env.delegate;
      yield* Ref.update(env.mapNow, (map) => ({ ...map, paused: true }));
      // The follower reads the result while paused, fails as unreachable and backs off. Each
      // lookup reads the map once, so that look decides the failure.
      yield* Deferred.succeed(env.vpsRun.finished, undefined);
      yield* Deferred.await(env.pausedLook);
      yield* Ref.update(env.mapNow, (map) => ({ ...map, paused: false }));
      // A final failure would end the task as failed here instead.
      expect(yield* env.taskResult(delegated.taskId)).toMatchObject({
        status: "completed",
        result: vpsReply,
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
