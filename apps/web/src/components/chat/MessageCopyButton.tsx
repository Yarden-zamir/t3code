import { memo, useRef } from "react";
import { Check, Copy } from "lucide";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../ui/anchoredCopyToast";
import type { KeybindingCommand } from "@t3tools/contracts";
import { ShortcutTrigger } from "../focusLevels/ShortcutHint";
import { Tooltip, TooltipPopup } from "../ui/tooltip";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  label = "Copy message",
  icon = Copy,
  extraFlavors,
  size = "xs",
  variant = "outline",
  className,
  keybindingCommand = null,
}: {
  text: string;
  /** The keybinding command that copies the same text, such as `timeline.copyMessageLink`. */
  keybindingCommand?: KeybindingCommand | null;
  label?: string;
  icon?: typeof Copy;
  extraFlavors?: Readonly<Record<string, string>>;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error: Error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    ...(extraFlavors ? { extraFlavors } : {}),
  });

  return (
    <Tooltip>
      <ShortcutTrigger
        command={keybindingCommand}
        render={
          <Button
            aria-label={label}
            disabled={isCopied}
            onClick={() => copyToClipboard(text)}
            ref={ref}
            type="button"
            size={size}
            variant={variant === "ghost" ? "ghost-muted" : variant}
            className={className}
          />
        }
      >
        <MorphIcon
          className={cn("size-3", isCopied && "text-primary")}
          icon={isCopied ? Check : icon}
        />
      </ShortcutTrigger>
      <TooltipPopup>
        <p>{label}</p>
      </TooltipPopup>
    </Tooltip>
  );
});
