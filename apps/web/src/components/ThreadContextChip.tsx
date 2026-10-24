import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { MessageId, ThreadContextRecord } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { HashIcon, MessagesSquareIcon } from "lucide-react";

import { forkMessageLinkNavigation } from "./chat/ForkMessageLinkTarget";
import { useProject, useThreadShell } from "~/state/entities";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { ProjectFavicon } from "./ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ThreadContextChip(props: {
  record: Pick<ThreadContextRecord, "environmentId" | "threadId" | "title">;
  copyMarkdown?: string;
  unreadable?: boolean;
  /** Fork: the link opens the thread at this message. */
  messageId?: MessageId | null;
}) {
  const { environmentId, threadId } = props.record;
  const shell = useThreadShell({ environmentId, threadId });
  const project = useProject(shell ? scopeProjectRef(environmentId, shell.projectId) : null);
  const title = shell?.title?.trim() || props.record.title;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            {...(props.unreadable ? { state: "invalid" as const } : {})}
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId }}
                {...forkMessageLinkNavigation(props.messageId)}
              />
            }
            aria-label={`${props.messageId ? "Message in thread" : "Thread"}, ${title}`}
            data-markdown-copy={props.copyMarkdown}
            className="no-underline"
          >
            {project ? (
              <ProjectFavicon project={project} className="size-[1.17em] self-center" />
            ) : (
              <MessagesSquareIcon />
            )}
            <ContextChipLabel>{title}</ContextChipLabel>
            {props.messageId ? <HashIcon aria-hidden /> : null}
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        {props.unreadable
          ? "On another machine, so this machine's agent can't read it. Remove it or switch back to send."
          : shell
            ? props.messageId
              ? "Open message"
              : "Open thread"
            : "Thread no longer available"}
      </TooltipPopup>
    </Tooltip>
  );
}
