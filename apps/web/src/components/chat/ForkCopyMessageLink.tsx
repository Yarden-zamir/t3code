import type { KeybindingCommand, ScopedThreadRef } from "@t3tools/contracts";
import { formatThreadLinkHref } from "@t3tools/shared/threadLinks";
import { Link } from "lucide";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { runRegisteredFocusLevelCommand } from "../focusLevels/useFocusLevelShortcuts";
import { toastManager } from "../ui/toast";
import { useForkMessageLinks } from "./ForkMessageLinkTarget";
import { MessageCopyButton } from "./MessageCopyButton";

export function ForkCopyMessageLink(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly messageId: string;
  readonly standalone?: boolean;
}) {
  const enabled = useForkMessageLinks(props.threadRef?.environmentId ?? null);
  if (!enabled || !props.threadRef) return null;
  const button = (
    <MessageCopyButton
      text={formatThreadLinkHref(props.threadRef.threadId, props.messageId)}
      label="Copy message link"
      icon={Link}
      variant="ghost"
    />
  );
  return props.standalone ? (
    <div className="mt-1.5 opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100">
      {button}
    </div>
  ) : (
    button
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
    copyToClipboard(formatThreadLinkHref(threadRef.threadId, messageId));
    return true;
  };
}

export function handleForkMessageLinkPaletteShortcut(
  command: KeybindingCommand | null,
  event: { preventDefault(): void; stopPropagation(): void },
  close: () => void,
): boolean {
  if (command !== "timeline.copyMessageLink") return false;
  event.preventDefault();
  event.stopPropagation();
  close();
  runRegisteredFocusLevelCommand(command);
  return true;
}
