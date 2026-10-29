/**
 * Fork: thread attestation for kitshn (section 17). A local service presents the MCP credential of
 * an agent's thread and learns the current state of that thread. The check does not extend the idle
 * life of the credential, so a polling service cannot keep a dead agent's credential alive.
 */
import type { ForkThreadIdentity } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

const INACTIVE: ForkThreadIdentity = { active: false };

export class ThreadIdentity extends Context.Service<
  ThreadIdentity,
  {
    readonly check: (
      rawToken: string,
    ) => Effect.Effect<
      ForkThreadIdentity,
      ProjectionStoreV2.ProjectionStoreV2Error | ProjectStore.ProjectStoreV2Error
    >;
  }
>()("t3/fork/ThreadIdentity") {}

const make = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const projections = yield* ProjectionStoreV2.ProjectionStoreV2;
  // The stored row only: the project service also probes the repository, which takes seconds.
  const projects = yield* ProjectStore.ProjectStoreV2;

  const check: ThreadIdentity["Service"]["check"] = Effect.fn("ThreadIdentity.check")(
    function* (rawToken) {
      const scope = yield* registry.inspect(rawToken);
      if (scope === undefined) return INACTIVE;
      const thread = yield* projections
        .getThread(scope.thread.threadId)
        .pipe(
          Effect.asSome,
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeedNone }),
        );
      // The credential is revoked only after an archive or delete commits, so check both here.
      if (
        Option.isNone(thread) ||
        thread.value.archivedAt !== null ||
        thread.value.deletedAt !== null
      )
        return INACTIVE;
      const project = yield* projects.get(thread.value.projectId, { includeDeleted: true });
      if (Option.isNone(project)) {
        return yield* Effect.die(`Project ${thread.value.projectId} of a thread is missing.`);
      }
      const { lineage, delegatedFrom } = thread.value;
      // A child delegated from a linked environment has its parent only in `delegatedFrom`.
      const parent =
        lineage.relationshipToParent === "subagent"
          ? { threadId: lineage.parentThreadId, environmentId: null }
          : delegatedFrom === undefined
            ? null
            : {
                threadId: delegatedFrom.threadId,
                environmentId:
                  delegatedFrom.environmentId === scope.environmentId
                    ? null
                    : delegatedFrom.environmentId,
              };
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      return {
        active: true,
        threadId: thread.value.id,
        threadTitle: thread.value.title,
        projectId: thread.value.projectId,
        projectName: project.value.title,
        environmentId: scope.environmentId,
        providerInstanceId: thread.value.providerInstanceId,
        runtimeMode: thread.value.runtimeMode,
        interactionMode: thread.value.interactionMode,
        subagent: parent !== null,
        parentThreadId: parent?.threadId ?? null,
        parentEnvironmentId: parent?.environmentId ?? null,
        checkedAt,
      };
    },
  );

  return ThreadIdentity.of({ check });
});

export const layer = Layer.effect(ThreadIdentity, make);
