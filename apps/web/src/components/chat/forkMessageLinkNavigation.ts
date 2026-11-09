import type { MessageId } from "@t3tools/contracts";
import type { HistoryState } from "@tanstack/react-router";

import { randomUUID } from "../../lib/utils";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Fork: a new value on each message link click, so the same link pushes a new entry. */
    forkMessageLinkActivation?: string;
  }
}

/** Fork: the props of a thread `Link` that opens the thread at `messageId`, or none. */
export function forkMessageLinkNavigation(messageId: MessageId | null | undefined) {
  if (!messageId) return {};
  return {
    hash: messageId,
    resetScroll: false,
    state: (current: HistoryState) => ({
      ...current,
      forkMessageLinkActivation: randomUUID(),
    }),
  };
}
