import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import { makeListSharedThreads } from "../fork/kitshn/sharedThreads.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as GuestShareService from "./GuestShareService.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for guest shares"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "guest-share-fork" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
// The T3 Connect host, or null for a fork build that has no T3 Connect.
const connectHost = Ref.makeUnsafe<string | null>("env.t3.test");
const layerConnect = Layer.mock(CloudManagedEndpointRuntime)({
  inspectConnector: Effect.map(Ref.get(connectHost), (hostname) =>
    hostname === null ? null : { readyConnections: 1, hostname, protocol: "http2" },
  ),
});
const layerCleanup = Layer.mock(ResourceCleanupService.ResourceCleanupService)({
  cleanupScheduledTasks: () => Effect.void,
  cleanupTerminals: () => Effect.void,
  cleanupPreviews: () => Effect.void,
  cleanupAttachments: () => Effect.void,
});
const layerConfigWith = (tunnelPairingUrl: string | undefined) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, tunnelPairingUrl })),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-guest-share-fork-" })),
    Layer.provide(NodeServices.layer),
  );
const layerTestWith = (tunnelPairingUrl: string | undefined) =>
  GuestShareService.layer.pipe(
    Layer.provideMerge(
      CommandOutputHub.layer.pipe(
        Layer.provideMerge(layerOrchestration.pipe(Layer.provide(layerCleanup))),
      ),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ),
    Layer.provideMerge(ServerSettings.layerTest({ guestSharingEnabled: true })),
    Layer.provide(layerConnect),
    Layer.provide(Layer.mock(AnalyticsService.AnalyticsService)({ record: () => Effect.void })),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(layerConfigWith(tunnelPairingUrl)),
    Layer.provideMerge(NodeServices.layer),
  );
const layerTest = layerTestWith(undefined);
const layerTunnel = layerTestWith("https://t3-vps.example.test");

const createThread = Effect.fn(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("project:guest-share-fork"),
    title: "Review me",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

it.effect(
  "makes links on the tunnel host without T3 Connect, and ends them when the host changes",
  () =>
    Effect.gen(function* () {
      yield* Ref.set(connectHost, null);
      const threadId = ThreadId.make("thread:guest-share-tunnel");
      yield* createThread(threadId);
      const guestShares = yield* GuestShareService.GuestShareService;
      const { url, share } = yield* guestShares.create({ threadId });
      assert.isTrue(url.startsWith("https://t3-vps.example.test/guest#"));
      assert.equal(share.host, "t3-vps.example.test");
      const credential = url.slice(url.indexOf("#") + 1);
      const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
      yield* guestShares.check(session);

      // T3 Connect comes up on another host, so the link no longer matches the machine's host.
      yield* Ref.set(connectHost, "env.t3.test");
      assert.equal((yield* Effect.flip(guestShares.check(session))).reason, "inactive");
    }).pipe(Effect.provide(layerTunnel)),
);

it.effect("refuses a link without T3 Connect and without a tunnel", () =>
  Effect.gen(function* () {
    yield* Ref.set(connectHost, null);
    const threadId = ThreadId.make("thread:guest-share-no-host");
    yield* createThread(threadId);
    const guestShares = yield* GuestShareService.GuestShareService;
    const error = yield* Effect.flip(guestShares.create({ threadId }));
    assert.equal(error.reason, "connect_unavailable");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("opens a shared thread for a kitshn t3.thread grant: view reads, send also sends", () =>
  Effect.gen(function* () {
    yield* Ref.set(connectHost, "env.t3.test");
    const threadId = ThreadId.make("thread:guest-share-grant");
    yield* createThread(threadId);
    const guestShares = yield* GuestShareService.GuestShareService;
    const { url, share } = yield* guestShares.create({ threadId });

    // The thread cards of the kitshn provider list the open share.
    const shared = yield* yield* makeListSharedThreads;
    assert.deepInclude(Option.getOrThrow(shared), {
      threadId,
      title: "Review me",
      shareId: share.id,
      host: "env.t3.test",
      expiresAt: share.expiresAt,
    });

    const grantOf = (grant: GuestShareService.GuestGrant | null) => () => Effect.succeed(grant);
    assert.isNull(yield* guestShares.grantSession(share.id, grantOf(null)));
    assert.isNull(yield* guestShares.grantSession("no-such-share", grantOf("send")));

    // A view grant reads before any guest joined, and never sends.
    const view = (yield* guestShares.grantSession(share.id, grantOf("view")))!;
    assert.equal(view.threadId, threadId);
    yield* guestShares.check(view.token);
    const refused = yield* Effect.flip(
      guestShares.submit(view.token, { shareId: share.id, text: "Hello" }, []),
    );
    assert.equal(refused.reason, "rejected");

    // A send grant sends as the guest does, so the share needs its guest.
    const credential = url.slice(url.indexOf("#") + 1);
    yield* guestShares.redeem({ credential, name: "Sam" });
    const send = (yield* guestShares.grantSession(share.id, grantOf("send")))!;
    yield* guestShares.submit(send.token, { shareId: share.id, text: "Hello" }, []);
  }).pipe(Effect.provide(layerTest)),
);
