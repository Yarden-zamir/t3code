import type { MessageId, OrchestrationV2Run, RunId } from "@t3tools/contracts";

/**
 * Fork: the messages the assistant panel sent to one thread, each with the replies of its run.
 * The panel shows only these, never the thread history.
 */
export interface PanelExchange {
  readonly messageId: MessageId;
  /** What the user typed or said, without the attached context. */
  readonly text: string;
  readonly state: "working" | "done" | "stopped";
  readonly replies: ReadonlyArray<{ readonly messageId: MessageId; readonly text: string }>;
}

interface ExchangeItem {
  readonly type: string;
  readonly runId: RunId | null;
  readonly messageId?: MessageId;
  readonly text?: string;
}

export function panelExchanges(input: {
  readonly projection: {
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "userMessageId">>;
    readonly visibleTurnItems: ReadonlyArray<{ readonly item: ExchangeItem }>;
  } | null;
  readonly sent: ReadonlyArray<{ readonly messageId: MessageId; readonly text: string }>;
}): ReadonlyArray<PanelExchange> {
  return input.sent.map((message) => {
    const run = input.projection?.runs.find(
      (candidate) => candidate.userMessageId === message.messageId,
    );
    const replies = run
      ? (input.projection?.visibleTurnItems ?? []).flatMap(({ item }) =>
          item.type === "assistant_message" &&
          item.runId === run.id &&
          item.messageId !== undefined &&
          item.text?.trim()
            ? [{ messageId: item.messageId, text: item.text }]
            : [],
        )
      : [];
    // No run yet means the server still holds the message in its queue.
    const state =
      run?.status === "completed"
        ? "done"
        : run?.status === "failed" ||
            run?.status === "interrupted" ||
            run?.status === "cancelled" ||
            run?.status === "rolled_back"
          ? "stopped"
          : "working";
    return { messageId: message.messageId, text: message.text, state, replies };
  });
}
