import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { LegendListRef } from "@legendapp/list/react";
import type {
  EnvironmentId,
  MessageId,
  RunAttemptId,
  RunId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isLinkedMessage,
  messageLinkFromLocation,
  messageLinkStep,
} from "@t3tools/shared/threadMessageLinks";
import { type HistoryState, useLocation, useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState, type RefObject } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { randomUUID } from "../../lib/utils";
import type { TimelineEntry } from "../../session-logic";
import { useThreadStatus } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { toastManager } from "../ui/toast";
import { forkHistoryVisit, forkThreadKeyOfPath } from "./forkMessageHistory";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import {
  timelineTurnFoldRunIdsByEntryId,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import type { RememberedTimelinePosition } from "./timelineScrollAnchoring";

/*
 * Fork: opens a thread at one message. A `t3-thread://` link with `#<messageId>`, a thread
 * address with `#<messageId>` or `?message=<messageId>`, and an app link reach the thread route.
 * The timeline loads history, opens the fold, scrolls the message near the top and highlights it.
 * When pingdotgg/t3code#19203 merges, use its `useLinkedMessageTarget` and keep the fork links.
 */

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Fork: a new value on each message link click, so the same link pushes a new entry. */
    forkMessageLinkActivation?: string;
  }
}

/** Where a jump puts the timeline: a linked message, or where the user left a history entry. */
export type ForkTimelineTarget =
  | { readonly _tag: "message"; readonly messageId: MessageId }
  | { readonly _tag: "position"; readonly position: RememberedTimelinePosition };

export interface ForkMessageLinkRequest {
  /** A message id is as written in the link. Match rows with `isLinkedMessage`. */
  readonly target: ForkTimelineTarget;
  /** New on each visit of a history entry. */
  readonly key: string;
  /** `scopedThreadKey` of the thread. The timeline still shows the last thread for a moment. */
  readonly threadKey: string;
  /** The thread caught up with the server, so a message that it lacks is older history. */
  readonly synced: boolean;
}

/** Room above the linked message, so it does not sit flush against the top edge. */
const TOP_MARGIN_PX = 24;
/** Index scrolling starts from estimates; stop the corrections after about two seconds. */
const MAX_SETTLE_FRAMES = 120;
/** The highlight holds this long, then goes at once. No fade: a fade repaints every frame. */
const HIGHLIGHT_MS = 2400;
/** The history pages that one link may load before it gives up. */
const MAX_HISTORY_PAGES = 20;

/** The `messageLinks` server setting. On until the settings load, like its default. */
const messageLinksAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(serverEnvironment.settingsValueAtom(environmentId))?.messageLinks !== false,
  ),
);
const OFF_ATOM = Atom.make(false);

/** Fork: whether `environmentId` has the `messageLinks` setting on. */
export function useForkMessageLinks(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(environmentId ? messageLinksAtom(environmentId) : OFF_ATOM);
}

/** Fork: the props of a thread `Link` that opens the thread at `messageId`, or none. */
export function forkMessageLinkNavigation(messageId: MessageId | null | undefined) {
  if (!messageId) return {};
  return {
    hash: messageId,
    resetScroll: false,
    state: (current: HistoryState) => ({
      ...current,
      forkMessageLinkActivation: randomUUID(),
    }),
  };
}

/**
 * Fork: the timeline target of the location in the route thread `threadRef`. A first visit of an
 * entry opens the message in the address. A revisit returns to where the user left the entry, and
 * `revisit` tells ChatView to skip a citation in the address too. ChatView hands the request to
 * the timeline, which also renders outside a router.
 */
export function useForkMessageLinkRequest(threadRef: ScopedThreadRef | null): {
  readonly link: ForkMessageLinkRequest | null;
  readonly revisit: boolean;
} {
  const router = useRouter();
  // Primitives only: an object here is new on every router store update.
  const hash = useLocation({ select: (location) => location.hash });
  // ChatView, and the route params, still name the last thread for a moment after the location
  // names the next one.
  const pathname = useLocation({ select: (location) => location.pathname });
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const entryKey = useLocation({ select: (location) => location.state.__TSR_key ?? location.href });
  const routed =
    threadRef !== null && forkThreadKeyOfPath(router, pathname) === scopedThreadKey(threadRef);
  const visit = routed ? forkHistoryVisit(entryKey) : null;
  const messageId = visit && !visit.revisit ? messageLinkFromLocation(hash, searchStr) : null;
  const target: ForkTimelineTarget | null = visit?.position
    ? { _tag: "position", position: visit.position }
    : messageId
      ? { _tag: "message", messageId }
      : null;
  const status = useThreadStatus(target === null ? null : threadRef);
  if (visit === null || target === null || threadRef === null) {
    return { link: null, revisit: visit?.revisit ?? false };
  }
  return {
    link: {
      target,
      key: `${entryKey}:${visit.id}`,
      threadKey: scopedThreadKey(threadRef),
      synced: status === "live",
    },
    revisit: visit.revisit,
  };
}

function rowMessageId(row: MessagesTimelineRow): string | null {
  return row.kind === "message" ? row.message.id : null;
}

/** The row that `target` scrolls to, or null while the timeline does not show it. */
function targetRowId(
  target: ForkTimelineTarget | null,
  rows: ReadonlyArray<MessagesTimelineRow>,
): string | null {
  if (target === null) return null;
  if (target._tag === "message") {
    return (
      rows.find((row) => {
        const id = rowMessageId(row);
        return id !== null && isLinkedMessage(target.messageId, id);
      })?.id ?? null
    );
  }
  if (target.position.atEnd) return rows.at(-1)?.id ?? null;
  return rows.some((row) => row.id === target.position.rowId) ? target.position.rowId : null;
}

/**
 * Fork: scrolls the timeline to the target of `request`. A scroll, key or click from the user ends
 * it at any step. A message that the thread does not have shows the note "Message not found".
 */
export function useForkMessageLinkTarget({
  request: requestForAnyThread,
  threadKey,
  rows,
  listRef,
  listReady,
  viewport,
  historyLoading,
  historyControls,
  foldInput,
  expandRun,
  expandAttempt,
  onManualNavigation,
}: {
  request: ForkMessageLinkRequest | null;
  /** The thread that the timeline shows now. */
  threadKey: string;
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  listReady: boolean;
  viewport: HTMLElement | null;
  historyLoading: boolean;
  historyControls: MessagesTimelineHistoryControls | undefined;
  foldInput: Parameters<typeof timelineTurnFoldRunIdsByEntryId>[0];
  expandRun: (runId: RunId) => void;
  expandAttempt: (attemptId: RunAttemptId) => void;
  onManualNavigation: () => void;
}) {
  const request = requestForAnyThread?.threadKey === threadKey ? requestForAnyThread : null;
  const [finishedKey, setFinishedKey] = useState<string | null>(null);
  const progressRef = useRef<{
    key: string;
    requestedPages: Set<string>;
    revealed: boolean;
  } | null>(null);
  const positioning = request !== null && finishedKey !== request.key;
  const key = positioning ? request.key : null;
  const target = positioning ? request.target : null;
  const rowId = targetRowId(target, rows);

  const finish = useStableCallback((finished: string) => {
    if (finishedKey !== finished) setFinishedKey(finished);
  });

  // Without a row yet, load history through the message or open the fold that hides it.
  useEffect(() => {
    if (!request || !positioning || rowId !== null || !listReady) return;
    if (request.target._tag === "position") {
      // The row of a left position is gone, so the timeline stays where it is.
      finish(request.key);
      return;
    }
    const { messageId } = request.target;
    if (progressRef.current?.key !== request.key) {
      progressRef.current = { key: request.key, requestedPages: new Set(), revealed: false };
      onManualNavigation();
    }
    const progress = progressRef.current;
    const entry = foldInput.timelineEntries.find(
      (candidate: TimelineEntry) =>
        candidate.kind === "message" && isLinkedMessage(messageId, candidate.message.id),
    );
    const runId = entry ? timelineTurnFoldRunIdsByEntryId(foldInput).get(entry.id) : undefined;
    const attemptId = entry?.attempt?.status === "superseded" ? entry.attempt.id : undefined;
    const hasMoreHistory = historyControls?.hasMoreHistory === true;
    const cursor = foldInput.timelineEntries[0]?.id ?? "first";
    const step = messageLinkStep({
      synced: request.synced,
      // Each page lands before the next request, so a cursor already asked for is still loading.
      historyLoading:
        historyLoading ||
        historyControls?.loading === true ||
        (hasMoreHistory && progress.requestedPages.has(cursor)),
      shown: false,
      loaded: entry !== undefined,
      canExpand: !progress.revealed && (runId !== undefined || attemptId !== undefined),
      hasMoreHistory,
      // An error from before this link's own load is not about the linked message.
      historyExhausted:
        progress.requestedPages.size >= MAX_HISTORY_PAGES ||
        (progress.requestedPages.size > 0 && Boolean(historyControls?.error)),
    });
    if (step === "missing") {
      finish(request.key);
      toastManager.add({
        type: "info",
        title: "Message not found",
        description: "It was deleted, or the thread history no longer has it.",
      });
    } else if (step === "expand") {
      progress.revealed = true;
      if (runId !== undefined) expandRun(runId);
      if (attemptId !== undefined) expandAttempt(attemptId);
    } else if (step === "load") {
      progress.requestedPages.add(cursor);
      historyControls?.onLoadEarlier(messageId);
    }
  }, [
    expandAttempt,
    expandRun,
    finish,
    foldInput,
    historyControls,
    historyLoading,
    listReady,
    onManualNavigation,
    positioning,
    request,
    rowId,
  ]);

  // The user takes over at any step, including while history loads.
  useEffect(() => {
    if (key === null || !viewport) return;
    const cancel = () => finish(key);
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        cancel();
    };
    viewport.addEventListener("wheel", cancel, { passive: true });
    viewport.addEventListener("touchmove", cancel, { passive: true });
    viewport.addEventListener("pointerdown", cancel, { passive: true });
    viewport.addEventListener("keydown", onKeyDown);
    return () => {
      viewport.removeEventListener("wheel", cancel);
      viewport.removeEventListener("touchmove", cancel);
      viewport.removeEventListener("pointerdown", cancel);
      viewport.removeEventListener("keydown", onKeyDown);
    };
  }, [finish, key, viewport]);

  // Scroll the row into place, then correct for measured row sizes until it holds still.
  const historySettled = !historyLoading && historyControls?.loading !== true;
  // The position object comes from the history store, so it is stable across renders.
  const position = target?._tag === "position" ? target.position : null;
  useEffect(() => {
    const list = listRef.current;
    const scrollNode = list?.getScrollableNode();
    if (key === null || rowId === null || !listReady || !historySettled || !list) return;
    if (!(scrollNode instanceof HTMLElement)) return;
    let stopped = false;
    let frame: number | null = null;
    let frames = 0;
    let stableFrames = 0;
    const settle = () => {
      frame = null;
      if (stopped) return;
      frames += 1;
      if (frames > MAX_SETTLE_FRAMES) {
        stopped = true;
        finish(key);
        return;
      }
      const state = list.getState();
      const index = state.indexByKey(rowId);
      const element = index === undefined ? undefined : state.elementAtIndex(index);
      if (!element) {
        frame = requestAnimationFrame(settle);
        return;
      }
      const end = scrollNode.scrollHeight - scrollNode.clientHeight;
      const rowTop =
        scrollNode.scrollTop +
        element.getBoundingClientRect().top -
        scrollNode.getBoundingClientRect().top;
      const offset = position?.atEnd
        ? end
        : Math.max(
            0,
            Math.min(rowTop + (position ? position.offsetWithinRow : -TOP_MARGIN_PX), end),
          );
      if (Math.abs(scrollNode.scrollTop - offset) > 1) {
        stableFrames = 0;
        void list.scrollToOffset({ offset, animated: false }).then(() => {
          if (!stopped) frame = requestAnimationFrame(settle);
        });
        return;
      }
      stableFrames += 1;
      if (stableFrames < 2) {
        frame = requestAnimationFrame(settle);
        return;
      }
      stopped = true;
      if (!position) highlightRow(scrollNode.ownerDocument, rowId);
      finish(key);
      // ChatView's thread-open effect can run after the opt-out at the start. A position at the
      // end keeps the follow, so new output stays in view.
      if (!position?.atEnd) onManualNavigation();
    };
    const index = list.getState().indexByKey(rowId);
    void Promise.resolve(
      position?.atEnd
        ? list.scrollToEnd({ animated: false })
        : index === undefined
          ? undefined
          : list.scrollToIndex({
              index,
              animated: false,
              viewPosition: 0,
              viewOffset: position ? -position.offsetWithinRow : TOP_MARGIN_PX,
            }),
    ).then(() => {
      if (!stopped) frame = requestAnimationFrame(settle);
    });
    return () => {
      stopped = true;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [finish, historySettled, key, listReady, listRef, onManualNavigation, position, rowId]);

  return {
    positioning,
    pinnedRowId: rowId,
    alwaysRender: rowId === null ? undefined : { keys: [rowId] },
  };
}

/**
 * A style rule by row id, not a class on the row: the virtualized list reuses row containers, and
 * the rule follows the row when the list mounts it again.
 */
function highlightRow(document: Document, rowId: string) {
  const style = document.createElement("style");
  style.dataset.forkMessageLinkHighlight = "";
  style.textContent = `[data-timeline-row-id="${CSS.escape(rowId)}"] { background-color: color-mix(in srgb, var(--primary) 12%, transparent); border-radius: var(--radius-lg); }`;
  for (const previous of document.head.querySelectorAll("style[data-fork-message-link-highlight]"))
    previous.remove();
  document.head.append(style);
  window.setTimeout(() => style.remove(), HIGHLIGHT_MS);
}
