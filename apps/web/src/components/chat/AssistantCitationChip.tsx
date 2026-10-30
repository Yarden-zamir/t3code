import type { AssistantCitation } from "@t3tools/contracts";
import {
  assistantCitationLabel,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, PencilIcon, QuoteIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  assistantCitationHash,
  assistantCitationNavigation,
} from "../../lib/assistantCitationNavigation";
import { cn } from "~/lib/utils";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { ContextChipPopover } from "../contextChipParts";
import { copyFromObjectMenu, showObjectMenu } from "../../objectMenu";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";
import { composerFloatingLayerProps } from "./composerEventScope";
import { observeResize } from "~/lib/observeResize";

export function AssistantCitationChip({
  citation,
  composer = false,
  commentEditor,
}: {
  citation: AssistantCitation;
  composer?: boolean;
  commentEditor?: {
    open: boolean;
    sourceAnchor?: AssistantCitationSourceAnchor | undefined;
    onOpenChange: (open: boolean) => void;
    onCancel?: () => void;
    onSave: (comment: string) => boolean;
    onSaveAndSend?: (comment: string) => boolean;
    onDraftChange?: (comment: string) => void;
    onRestoreFocus?: () => void;
  };
}) {
  const navigate = useNavigate();
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const commentPopupRef = useRef<HTMLDivElement>(null);
  const commentTriggerRef = useRef<HTMLButtonElement>(null);
  const draftCommentRef = useRef<string | null>(null);
  const [unavailableSourceAnchor, setUnavailableSourceAnchor] =
    useState<AssistantCitationSourceAnchor | null>(null);
  const commentOpen = commentEditor?.open ?? false;
  const sourceAnchor = commentEditor?.sourceAnchor;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops the uncommitted comment draft held in a ref once the parent closes the comment editor
  useEffect(() => {
    if (!commentOpen) draftCommentRef.current = null;
  }, [commentOpen]);
  const settleDraftOnClose = (reason: string): boolean => {
    const dismissal = resolveAssistantCitationCommentDismissal({
      reason,
      draft: draftCommentRef.current,
      savedComment: citation.comment,
    });
    if (dismissal.kind === "commit") return commentEditor?.onSave(dismissal.comment) ?? true;
    return dismissal.kind !== "keep-open";
  };
  const onSourceUnavailable = useEffectEvent(() => {
    if (!sourceAnchor) return;
    if (settleDraftOnClose("none")) {
      commentEditor?.onOpenChange(false);
    } else {
      setUnavailableSourceAnchor(sourceAnchor);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the cited DOM source while the comment editor is open and reacts when it disappears
  useEffect(() => {
    if (!commentOpen || sourceAnchor === unavailableSourceAnchor) return;
    const anchor = sourceAnchor ?? findAssistantCitationSourceAnchor(document, citation);
    if (!anchor) return;
    return observeAssistantCitationCommentSource({
      anchor,
      citation,
      onUnavailable: onSourceUnavailable,
    });
  }, [citation, commentOpen, sourceAnchor, unavailableSourceAnchor]);
  // The card sits above its chip, inside the main pane. Anchored at the cited text, it could
  // cover the sidebar or the chip.
  // An element anchor, so the card follows the chip when the composer scrolls.
  const popupAnchor = () =>
    commentTriggerRef.current?.closest<HTMLElement>('[data-assistant-citation-chip="true"]') ??
    commentTriggerRef.current;
  const label = assistantCitationLabel(citation);
  const sourceLinkProps = {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: citation.environmentId, threadId: citation.threadId },
    hash: assistantCitationHash(citation),
    "data-markdown-copy": serializeAssistantCitation(citation),
    resetScroll: false,
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      void navigate(assistantCitationNavigation(citation));
    },
  };
  const composerSourceLink = (
    <Link
      {...sourceLinkProps}
      className="inline-flex min-w-0 items-center gap-[0.2em] self-baseline text-inherit no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current rounded-sm"
      aria-label={`View cited assistant text: ${label}`}
    >
      <QuoteIcon aria-hidden="true" />
      <ContextChipLabel className="max-w-[16em]">{label}</ContextChipLabel>
    </Link>
  );
  const goToSource = () => void navigate(assistantCitationNavigation(citation));
  const copyQuote = {
    label: "Copy quote",
    icon: "copy",
    run: () => copyFromObjectMenu(citation.text, "Copy quote"),
  };
  if (!composer) {
    return (
      <ContextChipPopover
        kind="citation"
        icon={<QuoteIcon />}
        label={label}
        accessibleLabel={`Quoted assistant text: ${label}`}
        copyMarkdown={serializeAssistantCitation(citation)}
        onContextMenu={(event) => {
          const chip = event.currentTarget;
          showObjectMenu(event, [
            { label: "Show quote", run: () => chip.click() },
            { label: "Go to source", run: goToSource },
            copyQuote,
          ]);
        }}
      >
        <div className="flex max-h-[calc(var(--available-height)_-_1rem_-_2px)] flex-col items-start gap-3 p-1 text-sm">
          <AssistantCitationQuote citation={citation} />
          <PopoverClose
            render={<Button variant="outline" size="sm" render={<Link {...sourceLinkProps} />} />}
          >
            <ArrowUpRightIcon aria-hidden="true" />
            Go to source
          </PopoverClose>
        </div>
      </ContextChipPopover>
    );
  }
  return (
    <ContextChip
      kind="citation"
      contentEditable={false}
      onContextMenu={(event) =>
        showObjectMenu(event, [
          { label: "Go to source", run: goToSource },
          commentEditor
            ? {
                label: citation.comment ? "Edit note" : "Add note",
                run: () => commentTriggerRef.current?.click(),
              }
            : null,
          copyQuote,
        ])
      }
      data-assistant-citation-chip="true"
      data-markdown-copy={serializeAssistantCitation(citation)}
    >
      {composerSourceLink}
      {commentEditor ? (
        <Popover
          open={commentEditor.open}
          onOpenChange={(open, eventDetails) => {
            if (!open && !settleDraftOnClose(eventDetails.reason)) {
              eventDetails.cancel();
              return;
            }
            commentEditor.onOpenChange(open);
          }}
        >
          <PopoverTrigger
            ref={commentTriggerRef}
            aria-label={citation.comment ? "Edit citation comment" : "Add comment to citation"}
            data-citation-comment-trigger="true"
            render={<ContextChipAction />}
          >
            <PencilIcon aria-hidden="true" />
          </PopoverTrigger>
          {commentEditor.open ? (
            <PopoverPopup
              {...composerFloatingLayerProps}
              side="top"
              align="start"
              anchor={popupAnchor}
              initialFocus={() => {
                commentInputRef.current?.focus({ preventScroll: true });
                return false;
              }}
              finalFocus={
                commentEditor.onRestoreFocus
                  ? () => {
                      const activeElement = document.activeElement;
                      if (
                        activeElement === document.body ||
                        (activeElement !== null && commentPopupRef.current?.contains(activeElement))
                      ) {
                        commentEditor.onRestoreFocus?.();
                      }
                      return false;
                    }
                  : undefined
              }
              ref={commentPopupRef}
              aria-label="Edit citation comment"
              width="md"
              padding="compact"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <AssistantCitationCommentEditor
                key={serializeAssistantCitation(citation)}
                citation={citation}
                inputRef={commentInputRef}
                onDraftChange={(comment) => {
                  draftCommentRef.current = comment;
                  commentEditor.onDraftChange?.(comment);
                }}
                onSubmit={(comment) => {
                  if (!commentEditor.onSave(comment)) return false;
                  commentEditor.onOpenChange(false);
                  return true;
                }}
                {...(commentEditor.onSaveAndSend
                  ? {
                      onSubmitAndSend: (comment: string) => {
                        if (!commentEditor.onSaveAndSend?.(comment)) return false;
                        commentEditor.onOpenChange(false);
                        return true;
                      },
                    }
                  : {})}
                onCancel={() => {
                  if (commentEditor.onCancel) {
                    commentEditor.onCancel();
                  } else {
                    commentEditor.onOpenChange(false);
                  }
                }}
              />
            </PopoverPopup>
          ) : null}
        </Popover>
      ) : null}
    </ContextChip>
  );
}

function AssistantCitationQuote({ citation }: { citation: AssistantCitation }) {
  const [fade, setFade] = useState({ top: false, bottom: false });
  const updateFade = (element: HTMLElement) => {
    const top = element.scrollTop > 1;
    const bottom = element.scrollHeight - element.clientHeight - element.scrollTop > 1;
    setFade((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  };
  const observeFade = (element: HTMLDivElement | null) =>
    element ? observeResize(element, () => updateFade(element)) : undefined;
  return (
    <div
      ref={observeFade}
      onScroll={(event) => updateFade(event.currentTarget)}
      className={cn(
        "max-h-64 min-h-0 space-y-3 self-stretch overflow-y-auto whitespace-pre-wrap wrap-break-word",
        getVirtualizedScrollFadeClassName(fade),
      )}
    >
      <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
        {citation.text}
      </blockquote>
      {citation.comment ? <p>{citation.comment}</p> : null}
    </div>
  );
}
