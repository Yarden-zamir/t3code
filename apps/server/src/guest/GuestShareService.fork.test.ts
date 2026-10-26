import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as MachineMapState from "../fork/machineMap/MachineMapState.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as ForkGuestShare from "../fork/forkGuestShare.ts";
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
// The machine map pause (MM-718), as the portal's desired state sets it.
const paused = Ref.makeUnsafe(false);
const layerMachineMap = Layer.unwrap(
  Effect.map(Queue.unbounded<never>(), (clientSeen) =>
    Layer.mock(MachineMapState.MachineMapState)({
      lockedFor: () => Ref.get(paused),
      trustsPeerOrigin: () => false,
      peerOrigins: () => [],
      clientSeen,
    }),
  ),
);
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
    Layer.provide(layerMachineMap),
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

it.effect("refuses every guest request while the machine map pauses the machine", () =>
  Effect.gen(function* () {
    yield* Ref.set(paused, false);
    yield* Ref.set(connectHost, "env.t3.test");
    const threadId = ThreadId.make("thread:guest-share-paused");
    yield* createThread(threadId);
    const guestShares = yield* GuestShareService.GuestShareService;
    const { url } = yield* guestShares.create({ threadId });
    const credential = url.slice(url.indexOf("#") + 1);
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });
    const collecting = yield* Stream.runCollect(yield* guestShares.stream(session)).pipe(
      Effect.forkChild,
    );

    yield* Ref.set(paused, true);
    // An open stream closes at the next access check.
    yield* TestClock.adjust("30 seconds");
    yield* Fiber.join(collecting);
    assert.equal((yield* Effect.flip(guestShares.check(session))).reason, "inactive");

    // The end of the pause lets the same guest back in.
    yield* Ref.set(paused, false);
    assert.isTrue(Exit.isSuccess(yield* Effect.exit(guestShares.check(session))));
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "makes links on the tunnel host without T3 Connect, and ends them when the host changes",
  () =>
    Effect.gen(function* () {
      yield* Ref.set(paused, false);
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
    yield* Ref.set(paused, false);
    yield* Ref.set(connectHost, null);
    const threadId = ThreadId.make("thread:guest-share-no-host");
    yield* createThread(threadId);
    const guestShares = yield* GuestShareService.GuestShareService;
    const error = yield* Effect.flip(guestShares.create({ threadId }));
    assert.equal(error.reason, "connect_unavailable");
  }).pipe(Effect.provide(layerTest)),
);

// A 1x1 PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A finished tool call in `threadId` whose output holds one PNG, as a browser screenshot does. */
const writeScreenshot = Effect.fn(function* (threadId: ThreadId, id: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`message:${id}`),
    threadId,
    messageId: MessageId.make(`message:${id}`),
    text: "Take a screenshot",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });
  const { runs } = (yield* orchestrator.getThreadSnapshotWindow(threadId, { rowLimit: 10 }))
    .projection;
  const now = yield* DateTime.now;
  yield* (yield* EventSink.EventSinkV2).write({
    events: [
      {
        id: EventId.make(`event:${id}`),
        type: "turn-item.updated",
        threadId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(id),
          threadId,
          runId: runs[0]!.id,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          title: null,
          status: "completed",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "dynamic_tool",
          toolName: "mcp__t3-code__preview_screenshot",
          input: null,
          output: { content: [{ type: "image", mimeType: "image/png", data: PNG_BASE64 }] },
        },
      },
    ],
  });
});

it.effect("serves the shared thread's tool images to its guest, never another thread's", () =>
  Effect.gen(function* () {
    yield* Ref.set(paused, false);
    yield* Ref.set(connectHost, "env.t3.test");
    const shared = ThreadId.make("thread:guest-share-images");
    const other = ThreadId.make("thread:guest-share-images-other");
    yield* createThread(shared);
    yield* createThread(other);
    yield* writeScreenshot(shared, "item:shared-screenshot");
    yield* writeScreenshot(other, "item:other-screenshot");
    const guestShares = yield* GuestShareService.GuestShareService;
    const { url } = yield* guestShares.create({ threadId: shared });
    const credential = url.slice(url.indexOf("#") + 1);
    const { token: session } = yield* guestShares.redeem({ credential, name: "Sam" });

    const image = yield* ForkGuestShare.guestToolOutputImage(session, "item:shared-screenshot", 0);
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual(image.bytes, Buffer.from(PNG_BASE64, "base64"));
    const reasons = yield* Effect.forEach(
      [
        // Another thread's item, an index past the output's images, and the invite as a session.
        [session, "item:other-screenshot", 0],
        [session, "item:shared-screenshot", 1],
        [credential, "item:shared-screenshot", 0],
      ] as const,
      ([token, itemId, index]) =>
        Effect.flip(ForkGuestShare.guestToolOutputImage(token, itemId, index)).pipe(
          Effect.map((error) => error.reason),
        ),
    );
    assert.deepEqual(reasons, ["unavailable", "unavailable", "invalid"]);

    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close:guest-share-images"),
      threadId: shared,
    });
    const closed = yield* Effect.flip(
      ForkGuestShare.guestToolOutputImage(session, "item:shared-screenshot", 0),
    );
    assert.equal(closed.reason, "inactive");
  }).pipe(Effect.provide(layerTest)),
);
