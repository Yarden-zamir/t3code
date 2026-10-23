import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as GitManager from "../git/GitManager.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("settlement-project");

type AutoSettleCommand = Extract<OrchestrationV2Command, { readonly type: "thread.auto-settle" }>;

function makeThread(
  id: string,
  overrides: Partial<ProjectionStore.ProjectionSettlementCandidate> = {},
): ProjectionStore.ProjectionSettlementCandidate {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: PROJECT_ID,
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
    latestUserAuthoredMessageAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
    createdAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

it.effect("keeps a merged thread unsettled while its background command runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const mergedLink = {
        host: "example.test",
        repository: "owner/repository",
        number: 42,
        url: "https://example.test/owner/repository/pull/42",
        source: "manual",
        linkedAt: "2026-08-20T00:00:00.000Z",
        snapshot: {
          state: "merged",
          title: "Pull request",
          headBranch: "feature",
          baseBranch: "main",
          isDraft: false,
          updatedAt: NOW,
          syncedAt: NOW,
          mergedAt: NOW,
        },
        stack: null,
      } as const;
      const waiting = makeThread("background-typecheck", {
        pullRequests: [mergedLink],
        pendingBackgroundTasks: [
          { taskId: "typecheck", kind: "command", description: "vp run typecheck" },
        ],
      });
      const idle = makeThread("merged-idle", { pullRequests: [mergedLink] });

      const activation = yield* Deferred.make<void>();
      const candidateReads = yield* Queue.unbounded<void>();
      const commands = yield* Ref.make<ReadonlyArray<AutoSettleCommand>>([]);
      const layer = ThreadSettlementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () =>
                Effect.succeed([
                  {
                    id: PROJECT_ID,
                    title: "Project",
                    workspaceRoot: "/workspace/project",
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-08-01T00:00:00.000Z",
                    updatedAt: NOW,
                  },
                ]),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getSettlementCandidates: () =>
                Queue.offer(candidateReads, undefined).pipe(Effect.as([waiting, idle])),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never as Stream.Stream<OrchestrationV2DomainEvent>,
              dispatch: (command) =>
                command.type === "thread.auto-settle"
                  ? Ref.update(commands, (recorded) => [...recorded, command]).pipe(
                      Effect.as({ sequence: 1, storedEvents: [] }),
                    )
                  : Effect.die(new Error(`Unexpected command: ${command.type}`)),
            }),
            Layer.mock(TerminalManager.TerminalManager)({}),
            Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: () => Effect.succeed(null),
              invalidateStatus: () => Effect.void,
            }),
            Layer.mock(PullRequestService.PullRequestService)({
              subscribeMerges: Effect.succeed(Stream.never),
            }),
            ServerSettings.layerTest({
              sidebarAutoSettleAfterDays: null,
              autoSettleWaitsForBackgroundCommands: true,
            }),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              Crypto.Crypto,
              Crypto.make({
                randomBytes: (size) => new Uint8Array(size).fill(1),
                digest: (_algorithm, data) => Effect.succeed(data),
              }),
            ),
            FileSystem.layerNoop({}),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* service.start();
        yield* Deferred.succeed(activation, undefined);
        yield* Queue.take(candidateReads);
        yield* service.drain;
        expect((yield* Ref.get(commands)).map((command) => command.threadId)).toEqual([idle.id]);
      }).pipe(Effect.provide(layer));
    }),
  ),
);
