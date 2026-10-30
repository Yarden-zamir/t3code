import type { KeybindingCommand, ScopedThreadRef } from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { Link } from "lucide";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { readThreadShell } from "../../state/entities";
import { runRegisteredFocusLevelCommand } from "../focusLevels/useFocusLevelShortcuts";
import { toastManager } from "../ui/toast";
import { useForkMessageLinks } from "./ForkMessageLinkTarget";
import { ForkPinMessageButton, useForkMessagePinsEnabled } from "./ForkMessagePins";
import { objectMenuActionsProps } from "../../objectMenu";
import { MessageCopyButton } from "./MessageCopyButton";

/**
 * Fork: a Markdown link to a message, labelled by the thread title, so a paste in chat is a chip.
 * Known limit: it reads the title without a subscription, so a button keeps an old title until its
 * row renders again. Revisit if renamed threads copy stale labels in practice.
 */
function messageLinkMarkdown(threadRef: ScopedThreadRef, messageId: string): string {
  const title = readThreadShell(threadRef)?.title ?? "";
  return formatThreadLink(threadRef, title, messageId);
}

/** Fork: Copy message link and the pin toggle of a message (`ForkMessagePins`). */
export function ForkCopyMessageLink(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly messageId: string;
  /** The text that a pin keeps as its excerpt. */
  readonly text?: string | undefined;
  readonly standalone?: boolean;
}) {
  const enabled = useForkMessageLinks(props.threadRef?.environmentId ?? null);
  const pins = useForkMessagePinsEnabled();
  if ((!enabled && !pins) || !props.threadRef) return null;
  const buttons = (
    <>
      {enabled ? (
        <MessageCopyButton
          text={messageLinkMarkdown(props.threadRef, props.messageId)}
          label="Copy message link"
          icon={Link}
          keybindingCommand="timeline.copyMessageLink"
          variant="ghost"
        />
      ) : null}
      {pins ? (
        <ForkPinMessageButton
          threadRef={props.threadRef}
          messageId={props.messageId}
          text={props.text}
        />
      ) : null}
    </>
  );
  return props.standalone ? (
    <div
      {...objectMenuActionsProps}
      className="mt-1.5 flex items-center gap-0.5 opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100 has-[[data-fork-pinned]]:opacity-100"
    >
      {buttons}
    </div>
  ) : (
    buttons
  );
}

export function useForkCopyMessageLink(threadRef: ScopedThreadRef | null) {
  const enabled = useForkMessageLinks(threadRef?.environmentId ?? null);
  const { copyToClipboard } = useCopyToClipboard({
    target: "message link",
    onCopy: () => toastManager.add({ type: "success", title: "Message link copied" }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Could not copy message link",
        description: error.message,
      }),
  });
  return (messageId: string | undefined) => {
    if (!enabled || !threadRef || !messageId) return false;
    copyToClipboard(messageLinkMarkdown(threadRef, messageId));
    return true;
  };
}

export function handleForkMessageLinkPaletteShortcut(
  command: KeybindingCommand | null,
  event: { preventDefault(): void; stopPropagation(): void },
  close: () => void,
): boolean {
  if (command !== "timeline.copyMessageLink" && command !== "timeline.pinMessage") return false;
  event.preventDefault();
  event.stopPropagation();
  close();
  runRegisteredFocusLevelCommand(command);
  return true;
}
