import {
  MESSAGE_PIN_EXCERPT_MAX,
  MESSAGE_PINS_MAX,
  type MessagePin,
  type PinnedMessages,
} from "@t3tools/contracts";

import { assistantCitationsToPlainText } from "./assistantCitations.ts";

/** Fork: a patch of the `pinnedMessages` server setting. `null` removes that pin. */
export type MessagePinsPatch = Readonly<Record<string, MessagePin | null>>;

export type PinMessageResult =
  | { readonly _tag: "Patch"; readonly patch: MessagePinsPatch }
  | { readonly _tag: "AlreadyPinned" }
  | { readonly _tag: "Full" };

/**
 * Whether a pin can open its message. A thread that the client does not list is archived or
 * deleted. A message is gone only when its thread is loaded with all its history.
 */
export type MessagePinState = "available" | "thread-missing" | "message-missing";

/** Fork: the key of a pin, in the shape of a thread link fragment. Message ids repeat in forks. */
export function messagePinKey(threadId: string, messageId: string): string {
  return `${threadId}#${messageId}`;
}

/**
 * Fork: the message text on one line, cut to `MESSAGE_PIN_EXCERPT_MAX` characters. A citation
 * shows as its quote, as in the composer stash.
 */
export function messagePinExcerpt(text: string): string {
  const line = assistantCitationsToPlainText(text).split(/\s+/).filter(Boolean).join(" ");
  return line.length <= MESSAGE_PIN_EXCERPT_MAX
    ? line
    : `${line.slice(0, MESSAGE_PIN_EXCERPT_MAX - 1).trimEnd()}…`;
}

export function pinMessagePatch(pins: PinnedMessages, pin: MessagePin): PinMessageResult {
  const key = messagePinKey(pin.threadId, pin.messageId);
  if (pins[key] !== undefined) return { _tag: "AlreadyPinned" };
  if (Object.keys(pins).length >= MESSAGE_PINS_MAX) return { _tag: "Full" };
  return { _tag: "Patch", patch: { [key]: pin } };
}

export function unpinMessagePatch(
  pin: Pick<MessagePin, "threadId" | "messageId">,
): MessagePinsPatch {
  return { [messagePinKey(pin.threadId, pin.messageId)]: null };
}

/**
 * Fork: the server merge of a pins patch. Removals come first. A new pin past the cap is dropped,
 * so a client that raced another one past the cap never removes a saved pin.
 */
export function applyMessagePinsPatch(
  current: PinnedMessages,
  patch: MessagePinsPatch,
): PinnedMessages {
  const next = new Map(Object.entries(current));
  for (const [key, pin] of Object.entries(patch)) {
    if (pin === null) next.delete(key);
  }
  for (const [key, pin] of Object.entries(patch)) {
    if (pin === null || (!next.has(key) && next.size >= MESSAGE_PINS_MAX)) continue;
    next.set(key, pin);
  }
  return Object.fromEntries(next);
}

export function messagePinsNewestFirst(pins: PinnedMessages): ReadonlyArray<MessagePin> {
  return Object.values(pins).sort((left, right) => right.pinnedAt.localeCompare(left.pinnedAt));
}

export function messagePinState(
  pin: MessagePin,
  thread: {
    readonly threadKnown: boolean;
    /** The message ids of the thread when it is loaded with all its history, else null. */
    readonly loadedMessageIds: ReadonlySet<string> | null;
  },
): MessagePinState {
  if (!thread.threadKnown) return "thread-missing";
  if (thread.loadedMessageIds !== null && !thread.loadedMessageIds.has(pin.messageId)) {
    return "message-missing";
  }
  return "available";
}
