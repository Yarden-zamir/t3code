import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { PROMPT_LINK_MAX_PROMPT_LENGTH } from "@t3tools/shared/promptLinks";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import type { ComponentProps } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import { copyPromptLink } from "../prompt-links/prompt-link-actions";
import { CopyTextButton } from "./CopyTextButton";
import { useForkMessageLinksEnabled } from "./forkMessageLinks";

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
  const enabled = useForkMessageLinksEnabled(environmentId) && messageId !== null;
  if ((!enabled && menuOnly) || (!enabled && !props.text)) return null;
  // A Markdown link labelled by the thread title, so a paste in chat is a chip. Known limit: the
  // title is read without a subscription and stays old until the row renders again.
  const shell = appAtomRegistry.get(
    environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId)),
  );
  const link = formatThreadLink(threadId, shell?.title ?? "", messageId ?? undefined);
  const linkText = replaceComposerContextReferences(props.text, (reference) => reference.label);
  const actions = [
    ...(enabled ? [{ id: "copy-message-link", title: "Copy message link", image: "link" }] : []),
    ...(promptLink && linkText.length <= PROMPT_LINK_MAX_PROMPT_LENGTH
      ? [{ id: "copy-prompt-link", title: "Copy prompt link", image: "link" }]
      : []),
  ];
  const button = (
    <CopyTextButton
      {...props}
      {...(!props.text && enabled
        ? { text: link, accessibilityLabel: "Copy message link", onCopy: undefined }
        : {})}
    />
  );
  if (actions.length === 0) return button;
  return (
    <Menu
      actions={actions}
      shouldOpenOnLongPress
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "copy-prompt-link") void copyPromptLink(linkText);
        if (nativeEvent.event === "copy-message-link") {
          void tryCopyTextWithHaptic(link, { target: "message link" }).then((copied) => {
            if (!copied) Dialog.alert("Could not copy message link", "Try again.");
          });
        }
      }}
    >
      {button}
    </Menu>
  );
}
