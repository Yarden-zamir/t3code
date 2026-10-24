import { MessageId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeMessageId = Schema.decodeUnknownOption(MessageId);

/**
 * Fork: the message id in the fragment of a thread link (`#<messageId>`), as written. A fragment
 * with `=`, such as `#assistant-citation=…` or `#codex-auth=…`, is app state, not a message.
 * Known limit: a message id with `=` cannot be linked. Revisit if a provider makes such ids.
 */
export function messageLinkFragmentId(fragment: string): MessageId | null {
  return fragment.includes("=") ? null : Option.getOrNull(decodeMessageId(fragment));
}

/** Fork: `messageLinkFragmentId` of the fragment of `href`, or null without a fragment. */
export function threadLinkMessageId(href: string): MessageId | null {
  const hash = href.indexOf("#");
  return hash < 0 ? null : messageLinkFragmentId(href.slice(hash + 1));
}

/**
 * Fork: whether a link that names `linkedId` points at `messageId`. Like thread ids, a message id
 * can hold percent escapes of its own, so the id as written comes first and the decoded id second.
 */
export function isLinkedMessage(linkedId: string, messageId: string): boolean {
  if (messageId === linkedId) return true;
  try {
    return decodeURIComponent(linkedId) === messageId;
  } catch {
    return false;
  }
}

/**
 * Fork: the message that a thread route location names: the fragment (`#<messageId>`) or the
 * `message` query param of an app link (`t3code://threads/…?message=`). `hash` has no `#`.
 */
export function messageLinkFromLocation(hash: string, search: string): MessageId | null {
  const fromHash = messageLinkFragmentId(hash);
  if (fromHash !== null) return fromHash;
  const message = new URLSearchParams(search).get("message");
  return message === null ? null : Option.getOrNull(decodeMessageId(message));
}

export type MessageLinkStep = "wait" | "scroll" | "expand" | "load" | "missing";

/** Fork: the next step of a client that opens a thread at a linked message. */
export function messageLinkStep(input: {
  /** The thread caught up with the server, so a message that it lacks is older history. */
  readonly synced: boolean;
  readonly historyLoading: boolean;
  /** The message is a row of the list. */
  readonly shown: boolean;
  /** The loaded thread has the message, but a fold can hide its row. */
  readonly loaded: boolean;
  /** A fold that hides the message is still closed. */
  readonly canExpand: boolean;
  readonly hasMoreHistory: boolean;
  /** A load for this link failed or loaded nothing, or the link used up its pages. */
  readonly historyExhausted: boolean;
}): MessageLinkStep {
  if (!input.synced || input.historyLoading) return "wait";
  if (input.shown) return "scroll";
  if (input.loaded) return input.canExpand ? "expand" : "missing";
  return input.hasMoreHistory && !input.historyExhausted ? "load" : "missing";
}
