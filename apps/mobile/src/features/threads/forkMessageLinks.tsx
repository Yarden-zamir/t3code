import type { LegendListRef } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, RunId } from "@t3tools/contracts";
import { isLinkedMessage, messageLinkStep } from "@t3tools/shared/threadMessageLinks";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { View } from "react-native";

import { Toast } from "../../components/ui/Toast";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { useEnvironmentServerConfig } from "../../state/entities";

/*
 * Fork: opens a thread at one message. A thread link with `#<messageId>`, a thread address with
 * `#<messageId>` or `?message=`, and an app link reach the Thread route with the `message` param.
 * The feed loads history through the message, opens its folded turn, scrolls to it and highlights
 * it briefly. A message that the thread does not have shows the note "Message not found".
 *
 * The open upstream PR pingdotgg/t3code#19203 ("link to a message in a thread from anywhere") does
 * the same with the `message` param. When it merges, replace this file with its feed code and keep
 * only the fork entry point: the fragment of a thread link.
 */

/** The highlight holds this long, then goes at once. No fade: a fade repaints every frame. */
const HIGHLIGHT_MS = 2400;
const NOTE_MS = 6000;
/** Stop aiming the scroll after about two seconds. */
const MAX_SETTLE_FRAMES = 120;
/** The history pages that one link may load before it gives up. */
const MAX_HISTORY_PAGES = 20;

export interface ForkMessageLinkRequest {
  /** As written in the link. Match entries with `isLinkedMessage`. */
  readonly messageId: string;
  readonly onHandled: () => void;
}

/** Fork: whether `environmentId` has the `messageLinks` server setting on. On until it loads. */
export function useForkMessageLinksEnabled(environmentId: EnvironmentId | null): boolean {
  return useEnvironmentServerConfig(environmentId)?.settings.messageLinks !== false;
}

/**
 * Fork: the message that the `message` param of the Thread route names, while the `messageLinks`
 * setting of its environment is on. Handling it clears the param, so the screen does not scroll
 * there again.
 */
export function useForkMessageLinkParam(
  message: string | string[] | undefined,
  environmentId: EnvironmentId | null,
): ForkMessageLinkRequest | undefined {
  const navigation = useNavigation();
  const enabled = useForkMessageLinksEnabled(environmentId);
  const messageId = (Array.isArray(message) ? message[0] : message)?.trim();
  if (!enabled || !messageId) return undefined;
  return { messageId, onHandled: () => navigation.setParams({ message: undefined }) };
}

function isMessageEntry(entry: ThreadFeedEntry, messageId: string) {
  return entry.type === "message" && isLinkedMessage(messageId, entry.id);
}

/**
 * Fork: the feed side of a message link. Returns the row to highlight, the note to show, and
 * `cancel` for a user drag, which ends the link at any step.
 */
export function useForkMessageLinkTarget(input: {
  readonly request: ForkMessageLinkRequest | undefined;
  /** The thread caught up with the server, so a message that it lacks is older history. */
  readonly synced: boolean;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly presentedFeed: ReadonlyArray<ThreadFeedEntry>;
  readonly historyControls:
    | {
        readonly hasMoreHistory: boolean;
        readonly loading: boolean;
        readonly error: string | null;
        readonly onLoadEarlier: (throughEntryId?: string) => Promise<unknown> | void;
      }
    | undefined;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly viewOffset: number;
  readonly expandedTurnIds: ReadonlySet<RunId>;
  readonly expandRun: (runId: RunId) => void;
  readonly stopEndFollow: () => void;
}) {
  const [highlightedRowId, setHighlightedRowId] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadInFlight, setLoadInFlight] = useState(false);
  const [handledId, setHandledId] = useState<string | null>(null);
  const progressRef = useRef<{
    messageId: string;
    pages: Set<string>;
    expanded: boolean;
  } | null>(null);
  const presentedFeedRef = useRef(input.presentedFeed);
  const settleRef = useRef<{ cancelled: boolean } | null>(null);
  useLayoutEffect(() => {
    presentedFeedRef.current = input.presentedFeed;
  }, [input.presentedFeed]);
  const { request } = input;
  const active = request !== undefined && handledId !== request.messageId;

  const finish = () => {
    if (request !== undefined) setHandledId(request.messageId);
  };
  // Clearing the route param can remount the feed, so it waits until the highlight or note ends.
  useEffect(() => {
    if (request && handledId === request.messageId && !highlightedRowId && !notFound) {
      request.onHandled();
    }
  });

  // The highlight holds from the end of the scroll, so a long scroll does not use it up.
  const [highlightSettled, setHighlightSettled] = useState(false);
  useEffect(() => {
    if (!highlightedRowId || !highlightSettled) return;
    const timer = setTimeout(() => {
      setHighlightedRowId(null);
      setHighlightSettled(false);
    }, HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightedRowId, highlightSettled]);
  useEffect(() => {
    if (!notFound) return;
    const timer = setTimeout(() => setNotFound(false), NOTE_MS);
    return () => clearTimeout(timer);
  }, [notFound]);

  useEffect(() => {
    if (!active) return;
    const { messageId } = request;
    if (progressRef.current?.messageId !== messageId) {
      progressRef.current = { messageId, pages: new Set(), expanded: false };
    }
    const progress = progressRef.current;
    const history = input.historyControls;
    const entry = input.feed.find((candidate) => isMessageEntry(candidate, messageId));
    // Known limit: a runless prompt folds under another key, so its hidden replies show as
    // missing. Revisit with pingdotgg/t3code#19203, which finds the fold that hides an entry.
    const runId = entry?.type === "message" ? entry.message.runId : null;
    // A finished load that left the oldest entry in place loaded nothing.
    const cursor = input.feed[0]?.id ?? "first";
    const step = messageLinkStep({
      synced: input.synced,
      historyLoading: loadInFlight || history?.loading === true,
      shown: input.presentedFeed.some((candidate) => isMessageEntry(candidate, messageId)),
      loaded: entry !== undefined,
      canExpand: !progress.expanded && runId !== null && !input.expandedTurnIds.has(runId),
      hasMoreHistory: history?.hasMoreHistory === true,
      historyExhausted:
        progress.pages.has(cursor) ||
        progress.pages.size >= MAX_HISTORY_PAGES ||
        (progress.pages.size > 0 && history?.error != null),
    });
    if (step === "wait") return;
    if (step === "load") {
      progress.pages.add(cursor);
      setLoadInFlight(true);
      void Promise.resolve(history?.onLoadEarlier(messageId)).finally(() => setLoadInFlight(false));
      return;
    }
    if (step === "missing") {
      finish();
      setNotFound(true);
      return;
    }
    input.stopEndFollow();
    if (step === "expand" && runId !== null) {
      progress.expanded = true;
      input.expandRun(runId);
      return;
    }
    finish();
    setHighlightedRowId(
      input.presentedFeed.find((candidate) => isMessageEntry(candidate, messageId))?.id ?? null,
    );
    setHighlightSettled(false);
    const settle = { cancelled: false };
    settleRef.current = settle;
    settleScroll({
      listRef: input.listRef,
      viewOffset: input.viewOffset,
      settle,
      findIndex: () =>
        presentedFeedRef.current.findIndex((candidate) => isMessageEntry(candidate, messageId)),
      onSettled: () => setHighlightSettled(true),
    });
  });

  return {
    highlightedRowId,
    notFound,
    dismissNote: () => setNotFound(false),
    cancel: () => {
      if (settleRef.current) settleRef.current.cancelled = true;
      if (active) finish();
    },
  };
}

/**
 * Index scrolling starts from estimated row sizes. Aims again while the rows above the target get
 * measured, until its position holds still. Outside the hook: React Compiler cannot lower the
 * counters of this loop.
 */
function settleScroll(input: {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly viewOffset: number;
  readonly settle: { readonly cancelled: boolean };
  /** Rows can change between frames, so the target is found again each frame. */
  readonly findIndex: () => number;
  readonly onSettled: () => void;
}) {
  let lastPosition: number | null = null;
  let stableFrames = 0;
  let frames = 0;
  const aim = () => {
    frames += 1;
    const index = input.findIndex();
    const list = input.listRef.current;
    if (input.settle.cancelled || frames > MAX_SETTLE_FRAMES || index < 0 || !list) {
      input.onSettled();
      return;
    }
    const position = list.getState().positionAtIndex(index);
    if (position === lastPosition) {
      stableFrames += 1;
      if (stableFrames >= 3) {
        input.onSettled();
        return;
      }
    } else {
      stableFrames = 0;
      lastPosition = position;
      void list.scrollToIndex({
        index,
        viewPosition: 0,
        viewOffset: input.viewOffset,
        animated: false,
      });
    }
    requestAnimationFrame(aim);
  };
  requestAnimationFrame(aim);
}

/** Fork: the small "Message not found" note at the top of the feed. */
export function ForkMessageLinkNote(props: {
  readonly visible: boolean;
  readonly top: number;
  readonly onDismiss: () => void;
}) {
  if (!props.visible) return null;
  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-3 z-[100]"
      style={{ top: props.top + 8 }}
    >
      <Toast message="Message not found" tone="danger" onDismiss={props.onDismiss} />
    </View>
  );
}
