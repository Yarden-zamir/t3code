import type { MessageId, OrchestrationV2Run, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type SpeakableRun = Pick<
  OrchestrationV2Run,
  "id" | "status" | "userMessageId" | "requestedAt" | "completedAt"
>;
/** The fields of a turn item that decide whether it is a finished reply. */
interface SpeakableItem {
  readonly type: string;
  readonly runId: RunId | null;
  readonly messageId?: MessageId;
  readonly text?: string;
  readonly streaming?: boolean;
}

export interface ReplyToSpeak {
  /** Completed runs to mark as handled, so none of them is read later. */
  readonly settledRunIds: ReadonlyArray<RunId>;
  /** The last reply of the newest of those runs, or null when it wrote none. */
  readonly reply: { readonly messageId: MessageId; readonly text: string } | null;
}

/**
 * Fork: which reply to read aloud for a thread. `after` picks the runs that count: runs that
 * completed at `sinceMs` or later, so a thread never reads its history, or the run of one sent
 * message. Failed and interrupted runs are skipped.
 */
export function replyToSpeak(input: {
  readonly projection: {
    readonly runs: ReadonlyArray<SpeakableRun>;
    readonly visibleTurnItems: ReadonlyArray<{ readonly item: SpeakableItem }>;
  };
  readonly after: { readonly sinceMs: number } | { readonly userMessageId: MessageId };
  readonly handledRunIds: ReadonlySet<RunId>;
}): ReplyToSpeak {
  const settled = [...input.projection.runs]
    .filter(
      (run) =>
        run.status === "completed" &&
        run.completedAt !== null &&
        ("userMessageId" in input.after
          ? run.userMessageId === input.after.userMessageId
          : DateTime.toEpochMillis(run.completedAt) >= input.after.sinceMs) &&
        !input.handledRunIds.has(run.id),
    )
    .sort(
      (left, right) =>
        DateTime.toEpochMillis(left.completedAt ?? left.requestedAt) -
        DateTime.toEpochMillis(right.completedAt ?? right.requestedAt),
    );
  const newest = settled.at(-1);
  if (!newest) return { settledRunIds: [], reply: null };
  const ofNewest = ({ item }: { readonly item: SpeakableItem }) =>
    item.type === "assistant_message" && item.runId === newest.id;
  // Wait for the reply to finish, or its run would be settled before it can be read.
  if (
    input.projection.visibleTurnItems.some(
      (entry) => ofNewest(entry) && entry.item.streaming === true,
    )
  ) {
    return { settledRunIds: [], reply: null };
  }
  const lastMessage = input.projection.visibleTurnItems.findLast(
    (entry) => ofNewest(entry) && (entry.item.text?.trim().length ?? 0) > 0,
  )?.item;
  return {
    settledRunIds: settled.map((run) => run.id),
    reply:
      lastMessage?.messageId !== undefined && lastMessage.text !== undefined
        ? { messageId: lastMessage.messageId, text: lastMessage.text }
        : null,
  };
}
