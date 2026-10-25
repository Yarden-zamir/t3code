import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { promptLinkAppPath } from "./promptLinks.ts";
import { messageLinkFragmentId } from "./threadMessageLinks.ts";

export interface ThreadAddress {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId?: MessageId;
}

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeMessageId = Schema.decodeUnknownOption(MessageId);

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Fork: the thread that a web address `https://<host>/<environmentId>/<threadId>` or an app link
 * `t3code://threads/<environmentId>/<threadId>` names, with optional `?message=` or `#<messageId>`.
 * The host does not matter: a client checks the environment id against its environments. Any other
 * query makes it a normal link, such as a prompt link (`promptLinks.ts`).
 */
export function parseThreadAddress(href: string): ThreadAddress | null {
  if (!URL.canParse(href)) return null;
  const url = new URL(href);
  const web = url.protocol === "https:" || url.protocol === "http:";
  const path = web ? `${url.pathname}${url.search}` : promptLinkAppPath(href);
  if (path === null) return null;
  const inApp = new URL(path, "https://app.invalid");
  const keys = [...inApp.searchParams.keys()];
  if (keys.some((key) => key !== "message")) return null;
  const segments = inApp.pathname.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  if (segments.length !== 2) return null;
  const [environmentSegment, threadSegment] = segments as [string, string];
  const environmentId = decodeSegment(environmentSegment);
  const threadId = decodeSegment(threadSegment);
  if (environmentId === null || threadId === null) return null;
  const thread = Option.getOrNull(
    Option.all({
      environmentId: decodeEnvironmentId(environmentId),
      threadId: decodeThreadId(threadId),
    }),
  );
  const message = inApp.searchParams.get("message");
  if (thread === null) return null;
  if (message !== null) {
    const messageId = Option.getOrNull(decodeMessageId(message));
    return messageId === null ? null : { ...thread, messageId };
  }
  // A fragment that names no message, such as app state, leaves a link to the thread.
  const fragment = decodeSegment(url.hash.slice(1));
  const messageId = fragment === null ? null : messageLinkFragmentId(fragment);
  return messageId === null ? thread : { ...thread, messageId };
}

/**
 * Fork: `parseThreadAddress`, only for an environment that `known` accepts. The path shape alone
 * also matches pages such as `https://github.com/<owner>/<repo>`, so a client must name the
 * environments it knows before a link becomes a thread.
 */
export function parseKnownThreadAddress(
  href: string,
  known: (environmentId: EnvironmentId) => boolean,
): ThreadAddress | null {
  const address = parseThreadAddress(href);
  return address !== null && known(address.environmentId) ? address : null;
}

/** Fork: the app link of a thread, the form that `parseThreadAddress` reads back. */
export function formatThreadAppLink(address: ThreadAddress): string {
  const base = `t3code://threads/${encodeURIComponent(address.environmentId)}/${encodeURIComponent(address.threadId)}`;
  return address.messageId === undefined
    ? base
    : `${base}?message=${encodeURIComponent(address.messageId)}`;
}
