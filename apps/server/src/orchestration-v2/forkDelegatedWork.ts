import type {
  OrchestrationV2Command,
  OrchestrationV2Run,
  OrchestrationV2StoredEvent,
  OrchestrationV2Subagent,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

/**
 * The failed run that a new message queues behind, when the queue waits only
 * because its provider failed. Something that tries the provider again starts
 * the held queue first and waits behind it, so the queue keeps its order. If
 * the provider fails again, the queue is held again with the new message in
 * it, so a retry costs one run, as the new message alone did before.
 *
 * A message the user sends from a client keeps the upstream rule: it starts
 * first and releases the hold. Stop, worktree and usage-limit holds wait for
 * the user, as upstream decides.
 */
export function forkProviderFailureRunToQueueBehind(input: {
  readonly command: MessageDispatch;
  readonly sentByUserFromClient: boolean;
  readonly startsOrQueuesRun: boolean;
  readonly blocked: boolean;
  readonly latestRun: OrchestrationV2Run | null;
  readonly nextQueuedRun: OrchestrationV2Run | undefined;
  readonly turnItems: Parameters<typeof latestRootProviderFailure>[1];
}): OrchestrationV2Run | undefined {
  const { latestRun, nextQueuedRun } = input;
  if (
    input.sentByUserFromClient ||
    !input.startsOrQueuesRun ||
    input.blocked ||
    input.command.restartContinuationOfRunId !== undefined ||
    latestRun === null ||
    nextQueuedRun?.queueHeld !== true ||
    nextQueuedRun.providerInstanceId !== latestRun.providerInstanceId
  )
    return undefined;
  const failureClass = latestRootProviderFailure(latestRun, input.turnItems)?.class;
  return failureClass === undefined ||
    failureClass === "usage_limit" ||
    failureClass === "validation_error"
    ? undefined
    : latestRun;
}

/**
 * Whether a committed command released a held queue of the thread it locked.
 * Nothing else starts that queue when no run is active, so the orchestrator
 * starts it after the commit.
 */
export function forkCommandReleasedQueue(
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
  threadId: ThreadId,
): boolean {
  return events.some(
    ({ event }) =>
      event.type === "run.updated" &&
      event.threadId === threadId &&
      event.payload.status === "queued" &&
      event.payload.queueHeld === false,
  );
}

/**
 * Whether a message into a delegated child can become a follow-up task that
 * the parent hears back from. Besides a person or the parent writing to the
 * child, the child's own wakes count: a background command or a nested
 * delegated task that finished. Monitor updates report progress, not new
 * work. A child watches no pull request: its parent does.
 *
 * Upstream: https://github.com/pingdotgg/t3code/pull/23542 "notify parents
 * after delegated background runs" covers notification wakes with the same
 * shape. When that merges, use its `mayStartSubagentFollowup` and keep the
 * delegated-completion case here.
 */
export function forkMayStartSubagentFollowup(command: MessageDispatch): boolean {
  if (command.scheduledTaskId !== undefined || command.restartContinuationOfRunId !== undefined)
    return false;
  if (command.delegatedCompletion !== undefined) return true;
  if (command.notification !== undefined) return command.notification.source.kind !== "monitor";
  return command.createdBy === "user" || command.creationSource === "mcp";
}

/** A wake that the child started itself, not a message that someone sent. */
export function forkIsChildWake(command: MessageDispatch): boolean {
  return command.notification !== undefined || command.delegatedCompletion !== undefined;
}

/**
 * The parent cancelled the newest task of this child, so the child's own
 * wakes no longer report to it. A message that the parent or the user sends
 * later starts a new task as before.
 */
export function forkParentCancelledChild(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  childThreadId: ThreadId,
): boolean {
  const startedAt = (task: OrchestrationV2Subagent) => task.startedAt ?? task.updatedAt;
  let newest: OrchestrationV2Subagent | undefined;
  for (const task of subagents) {
    if (task.origin !== "app_owned" || task.childThreadId !== childThreadId) continue;
    if (newest === undefined || DateTime.isGreaterThan(startedAt(task), startedAt(newest)))
      newest = task;
  }
  return newest?.status === "cancelled";
}
