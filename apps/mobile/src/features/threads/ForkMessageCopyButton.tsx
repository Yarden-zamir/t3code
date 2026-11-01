import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { PROMPT_LINK_MAX_PROMPT_LENGTH } from "@t3tools/shared/promptLinks";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import type { ComponentProps } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { LongPressMenu, type LongPressMenuEntry } from "../../components/LongPressMenu";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import { copyPromptLink } from "../prompt-links/prompt-link-actions";
import { CopyTextButton } from "./CopyTextButton";
import { useForkMessageLinksEnabled } from "./forkMessageLinks";
import { useForkMessagePin } from "./forkMessagePins";

/**
 * The message actions of a message's long-press menus: its copy button and its whole bubble
 * (`MessageBubbleMenu`) show the same entries.
 */
function useForkMessageMenuEntries(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: string | null;
  readonly text: string;
  readonly promptLink: boolean;
}): { readonly entries: LongPressMenuEntry[]; readonly link: string | null } {
  const { environmentId, threadId, messageId, text } = input;
  const enabled = useForkMessageLinksEnabled(environmentId) && messageId !== null;
  const pin = useForkMessagePin({ environmentId, threadId, messageId, text });
  // A Markdown link labelled by the thread title, so a paste in chat is a chip. Known limit: the
  // title is read without a subscription and stays old until the row renders again.
  const shell = appAtomRegistry.get(
    environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId)),
  );
  const link = formatThreadLink(
    { environmentId, threadId },
    shell?.title ?? "",
    messageId ?? undefined,
  );
  const linkText = replaceComposerContextReferences(text, (reference) => reference.label);
  const entries = [
    ...(enabled
      ? [
          {
            id: "copy-message-link",
            title: "Copy message link",
            image: "link",
            run: () => {
              void tryCopyTextWithHaptic(link, { target: "message link" }).then((copied) => {
                if (!copied) Dialog.alert("Could not copy message link", "Try again.");
              });
            },
          },
        ]
      : []),
    ...(input.promptLink && linkText.length <= PROMPT_LINK_MAX_PROMPT_LENGTH
      ? [
          {
            id: "copy-prompt-link",
            title: "Copy prompt link",
            image: "link",
            run: () => void copyPromptLink(linkText),
          },
        ]
      : []),
    ...(pin
      ? [
          pin.pinned
            ? { id: "unpin-message", title: "Unpin message", image: "pin.slash", run: pin.toggle }
            : { id: "pin-message", title: "Pin message", image: "pin", run: pin.toggle },
        ]
      : []),
  ];
  return { entries, link: enabled ? link : null };
}

export function ForkMessageCopyButton({
  environmentId,
  threadId,
  messageId,
  promptLink = false,
  menuOnly = false,
  ...props
}: ComponentProps<typeof CopyTextButton> & {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: string | null;
  readonly promptLink?: boolean;
  readonly menuOnly?: boolean;
}) {
  const { entries, link } = useForkMessageMenuEntries({
    environmentId,
    threadId,
    messageId,
    text: props.text,
    promptLink,
  });
  const hasPin = entries.some((entry) => entry.id.endsWith("pin-message"));
  if (link === null && !hasPin && (menuOnly || !props.text)) return null;
  const button = (
    <CopyTextButton
      {...props}
      {...(!props.text && link !== null
        ? { text: link, accessibilityLabel: "Copy message link", onCopy: undefined }
        : {})}
    />
  );
  return <LongPressMenu entries={entries}>{button}</LongPressMenu>;
}
