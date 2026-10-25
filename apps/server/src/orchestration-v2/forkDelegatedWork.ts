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
 * The failed run that a new message queues behind, when only a provider failure holds the queue.
 * A message to that provider starts the held queue first and waits behind it, so order holds and a
 * retry costs one run. A message the user sends from a client keeps the upstream rule: it starts
 * first and releases the hold. Stop, worktree and usage-limit holds wait for the user.
 */
export function forkProviderFailureRunToQueueBehind(input: {
  readonly command: MessageDispatch;
  readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
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
    input.providerInstanceId !== latestRun.providerInstanceId ||
    nextQueuedRun?.queueHeld !== true ||
    nextQueuedRun.providerInstanceId !== latestRun.providerInstanceId ||
    // Only messages queued behind the failed run wait on its failure. An older
    // hold, such as a Stop that a wake started ahead of, stays the user's.
    nextQueuedRun.ordinal < latestRun.ordinal
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
 * Whether a committed message released a held queue of its thread. Nothing
 * else starts that queue when no run is active, so the orchestrator starts it
 * after the commit.
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

/** A wake that the child started itself, not a message that someone sent. */
export function forkIsChildWake(command: MessageDispatch): boolean {
  return command.notification !== undefined || command.delegatedCompletion !== undefined;
}

/**
 * The parent cancelled or stopped the newest task of this child, so the
 * child's own wakes no longer report to it. `task_cancel` and Stop dispose the
 * delivery; the task itself can end interrupted. A message that the parent or
 * the user sends later starts a new task as before.
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
  return newest?.completionDelivery?.state === "disposed";
}
