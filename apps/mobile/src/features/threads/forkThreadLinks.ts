import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ComposerContextId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { parseKnownThreadAddress } from "@t3tools/shared/threadAddress";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { threadLinkMessageId } from "@t3tools/shared/threadMessageLinks";
import {
  linkThreadMarkers,
  threadMarkerTargets,
  type ThreadMarkerTargets,
} from "@t3tools/shared/threadMarkers";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { CONTEXT_CHIP_ICON_SOURCES } from "../../lib/contextChipIcons.generated";
import type { MarkdownLinkCustomization } from "../../native/SelectableMarkdownText.types";
import { enrichedContextLinkCustomization } from "../../native/useEnrichedLinkVariants";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { useForkMessageLinksEnabled } from "./forkMessageLinks";

// The pill of an attached thread with no record, so both looks stay one.
const threadPill = enrichedContextLinkCustomization(
  formatComposerContextHref("thread", "thread-link" as ComposerContextId),
);

/**
 * Fork: thread links in a feed of `environmentId` while its server setting `threadLinkChips` is on.
 * A `t3-thread://` link and a web address of a thread in an environment that this app knows
 * (`parseThreadAddress`) get the attached-thread pill. Such a web address opens the thread here,
 * not in the phone browser. With the setting off, both return nothing and links stay as they are.
 * With `messageLinks` on, a link that names a message opens the thread at it (`messageParams`), and
 * its pill shows a message icon.
 */
export function useForkThreadLinks(environmentId: EnvironmentId) {
  const navigation = useNavigation();
  const chips = useEnvironmentServerConfig(environmentId)?.settings.threadLinkChips === true;
  const messageLinks = useForkMessageLinksEnabled(environmentId);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const knownThreadAddress = useCallback(
    (href: string) => {
      return chips ? parseKnownThreadAddress(href, (id) => catalog.entries.has(id)) : null;
    },
    [catalog, chips],
  );
  /** True when the press opened a thread. */
  const openKnownThread = useCallback(
    (href: string) => {
      const address = knownThreadAddress(href);
      if (!address) return false;
      navigation.navigate("Thread", {
        environmentId: String(address.environmentId),
        threadId: String(address.threadId),
        ...(messageLinks && address.messageId ? { message: String(address.messageId) } : {}),
      });
      return true;
    },
    [knownThreadAddress, messageLinks, navigation],
  );
  /** The Thread route param that opens a `t3-thread://` link at its message. */
  const messageParams = useCallback(
    (href: string): { readonly message?: string } => {
      const messageId = messageLinks ? threadLinkMessageId(href) : null;
      return messageId === null ? {} : { message: messageId };
    },
    [messageLinks],
  );
  const linkCustomization = useCallback(
    (href: string): MarkdownLinkCustomization | undefined =>
      threadPill && chips && (parseThreadLinkHref(href) !== null || knownThreadAddress(href))
        ? messageLinks &&
          (threadLinkMessageId(href) !== null || knownThreadAddress(href)?.messageId)
          ? // The message bubble icon of review comment chips marks a message link.
            { ...threadPill, icon: CONTEXT_CHIP_ICON_SOURCES["message-circle"] }
          : threadPill
        : undefined,
    [chips, knownThreadAddress, messageLinks],
  );
  return useMemo(
    () => ({ openKnownThread, messageParams, linkCustomization }),
    [linkCustomization, messageParams, openKnownThread],
  );
}

const NO_MARKER_TARGETS: ThreadMarkerTargets = new Map();
// Null, not an empty Map: `Atom.make` reads an iterable as something other than a plain value.
const NO_MARKER_TARGETS_ATOM = Atom.make<ThreadMarkerTargets | null>(null);

/** Fork: `threadMarkerTargets` of a thread, while its server setting `threadLinkChips` is on. */
const threadMarkerTargetsAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = key.split("\u0000") as [EnvironmentId, ThreadId];
  const ref = scopeThreadRef(environmentId, threadId);
  return Atom.make((get): ThreadMarkerTargets => {
    if (get(serverEnvironment.configValueAtom(environmentId))?.settings.threadLinkChips !== true) {
      return NO_MARKER_TARGETS;
    }
    const messages = get(environmentThreadDetails.threadAtom(ref))?.projection.messages ?? [];
    return threadMarkerTargets(messages, Option.getOrNull(get.self<ThreadMarkerTargets>()));
  });
});

/**
 * Fork: `markdown` of a message in thread `threadId` with each `[Thread: …; ref=…]` marker that an
 * agent copied turned into a thread app link, which `useForkThreadLinks` then shows as a pill. Only
 * text with `ref=` reads the thread's messages.
 */
export function useForkThreadMarkers(
  markdown: string,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string {
  const targets = useAtomValue(
    markdown.includes("ref=")
      ? threadMarkerTargetsAtom(`${environmentId}\u0000${threadId}`)
      : NO_MARKER_TARGETS_ATOM,
  );
  return targets === null ? markdown : linkThreadMarkers(markdown, targets);
}
