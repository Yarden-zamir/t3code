import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadIdentity from "./ThreadIdentity.ts";

const environmentId = EnvironmentId.make("environment-identity");
const projectId = ProjectId.make("project-identity");
const instanceId = ProviderInstanceId.make("codex");
const LIVENESS_WINDOW_MS = 100;

const layerRegistry = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make({ livenessWindowMs: LIVENESS_WINDOW_MS }),
).pipe(
  Layer.provide(
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
  ),
  Layer.provide(
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const project: ProjectStore.ProjectRow = {
  projectId,
  title: "Kitshn",
  workspaceRoot: "/workspace/kitshn",
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const layerDependencies = Layer.mergeAll(
  layerRegistry,
  ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  // Only the stored project row: the check needs its title, never the repository probe.
  Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
  }),
);

const layer = ThreadIdentity.layer.pipe(Layer.provideMerge(layerDependencies));

const putThread = Effect.fn(function* (
  id: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
  type: "thread.created" | "thread.metadata-updated" = "thread.created",
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(id);
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId,
    title: id,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* store.apply({
    id: EventId.make(`event:${type}:${id}:${thread.title}`),
    type,
    threadId,
    occurredAt: now,
    payload: thread,
  });
  return thread;
});

const issueToken = Effect.fn(function* (threadId: ThreadId) {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const issued = yield* registry.issue({ threadId, providerInstanceId: instanceId });
  return issued.config.authorizationHeader.slice("Bearer ".length);
});

it.layer(layer)("ThreadIdentity", (it) => {
  it.effect("answers with the current title and modes of the credential's thread", () =>
    Effect.gen(function* () {
      const identity = yield* ThreadIdentity.ThreadIdentity;
      const thread = yield* putThread("thread-renamed", { title: "Old title" });
      const token = yield* issueToken(thread.id);
      expect(yield* identity.check(token)).toEqual({
        active: true,
        threadId: thread.id,
        threadTitle: "Old title",
        projectId,
        projectName: "Kitshn",
        environmentId,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
        interactionMode: "default",
        subagent: false,
        parentThreadId: null,
        parentEnvironmentId: null,
        checkedAt: expect.any(String),
      });

      yield* putThread(
        "thread-renamed",
        { title: "New title", runtimeMode: "approval-required", interactionMode: "plan" },
        "thread.metadata-updated",
      );
      expect(yield* identity.check(token)).toMatchObject({
        active: true,
        threadTitle: "New title",
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
    }),
  );

  it.effect("names the parent of a delegated child thread", () =>
    Effect.gen(function* () {
      const identity = yield* ThreadIdentity.ThreadIdentity;
      const parentThreadId = ThreadId.make("thread-parent");
      const child = yield* putThread("thread-child", {
        lineage: { parentThreadId, relationshipToParent: "subagent", rootThreadId: parentThreadId },
      });
      expect(yield* identity.check(yield* issueToken(child.id))).toMatchObject({
        active: true,
        threadId: child.id,
        subagent: true,
        parentThreadId,
        parentEnvironmentId: null,
      });
    }),
  );

  it.effect("names the parent of a child delegated from a linked environment", () =>
    Effect.gen(function* () {
      const identity = yield* ThreadIdentity.ThreadIdentity;
      const parentThreadId = ThreadId.make("thread-remote-parent");
      const parentEnvironmentId = EnvironmentId.make("environment-remote");
      const child = yield* putThread("thread-remote-child", {
        delegatedFrom: {
          environmentId: parentEnvironmentId,
          threadId: parentThreadId,
          title: "Lead",
        },
      });
      expect(yield* identity.check(yield* issueToken(child.id))).toMatchObject({
        active: true,
        subagent: true,
        parentThreadId,
        parentEnvironmentId,
      });
    }),
  );

  it.effect("answers only active false for an unknown or revoked credential", () =>
    Effect.gen(function* () {
      const identity = yield* ThreadIdentity.ThreadIdentity;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const thread = yield* putThread("thread-revoked");
      const token = yield* issueToken(thread.id);
      expect(yield* identity.check("unknown-token")).toStrictEqual({ active: false });
      yield* registry.revokeThread(thread.id);
      expect(yield* identity.check(token)).toStrictEqual({ active: false });
    }),
  );

  it.effect("answers active false for an archived or deleted thread before its revocation", () =>
    Effect.gen(function* () {
      const identity = yield* ThreadIdentity.ThreadIdentity;
      const now = yield* DateTime.now;
      const archived = yield* putThread("thread-archived", { archivedAt: now });
      const deleted = yield* putThread("thread-deleted", { deletedAt: now });
      expect(yield* identity.check(yield* issueToken(archived.id))).toStrictEqual({
        active: false,
      });
      expect(yield* identity.check(yield* issueToken(deleted.id))).toStrictEqual({ active: false });
    }),
  );

  it.effect("does not extend the idle life of the credential", () =>
    Effect.gen(function* () {
      const identity = yield* ThreadIdentity.ThreadIdentity;
      const thread = yield* putThread("thread-idle");
      const token = yield* issueToken(thread.id);
      yield* TestClock.adjust(LIVENESS_WINDOW_MS * 0.6);
      expect(yield* identity.check(token)).toMatchObject({ active: true });
      // An extended credential would stay alive until 1.6 windows after issue.
      yield* TestClock.adjust(LIVENESS_WINDOW_MS * 0.6);
      expect(yield* identity.check(token)).toStrictEqual({ active: false });
    }),
  );
});
