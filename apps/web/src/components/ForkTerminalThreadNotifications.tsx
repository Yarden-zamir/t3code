import {
  AuthTerminalReadScope,
  DEFAULT_TERMINAL_ID,
  sessionGrantsScope,
  type EnvironmentId,
  type TerminalSummary,
  type ThreadId,
} from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { CircleAlertIcon, CircleCheckIcon, MessageCircleQuestionIcon } from "lucide-react";

import { addThreadToast, closeThreadToasts } from "../forkInAppNotifications";
import { getClientSettings } from "../hooks/useSettings";
import { showInstalledAppNotification } from "../installedApp";
import { environmentSession } from "../state/session";
import { environmentShell } from "../state/shell";
import { terminalEnvironment } from "../state/terminal";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  threadNotificationTag,
} from "../threadNotifications";
import type { TrackNotification } from "./ThreadNotificationCoordinator";
import { toastManager } from "./ui/toast";

// Null while terminal reads are not granted or the metadata loads or fails, so that only real
// metadata counts as the first sight.
const terminalSummariesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<TerminalSummary> | null => {
    const session = get(environmentSession.sessionStateAtom(environmentId));
    const sessionValue = Option.getOrNull(AsyncResult.value(session));
    if (
      session._tag === "Failure" ||
      sessionValue === null ||
      !sessionGrantsScope(sessionValue, AuthTerminalReadScope)
    ) {
      return null;
    }
    const metadata = get(terminalEnvironment.metadata({ environmentId, input: null }));
    return metadata._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(metadata));
  }).pipe(Atom.withLabel(`fork-terminal-thread-notification-summaries:${environmentId}`)),
);

/**
 * Fork: notifications for terminal threads (`forkTerminalThreads.ts`), which have no agent runs
 * to notify about. A bell or an app notification asks for input; a program that ends completes,
 * or fails with a non-zero exit code. Same sound, toast and desktop rules as agent threads
 * (`ThreadNotificationCoordinator`), copied here so that the upstream presenter stays unchanged.
 */
export function watchForkTerminalThreadNotifications(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly router: AnyRouter;
  readonly environmentId: EnvironmentId;
  readonly trackNotification: TrackNotification;
}): () => void {
  const { registry, router, environmentId, trackNotification } = input;
  const shellAtom = environmentShell.stateValueAtom(environmentId);
  const summariesAtom = terminalSummariesAtom(environmentId);
  const activeThreadId = () => {
    const params = (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: string;
      threadId?: string;
    };
    return params.environmentId === environmentId ? (params.threadId ?? null) : null;
  };
  // The attention that each thread had last time; the first sight of a thread only records it.
  let seen: Map<string, string> | null = null;

  const observe = () => {
    const summaries = registry.get(summariesAtom);
    const shell = registry.get(shellAtom);
    const threads =
      shell.status === "live" && Option.isSome(shell.snapshot)
        ? shell.snapshot.value.threads
        : null;
    if (summaries === null || threads === null) return;
    const firstSight = seen === null;
    const previous = seen ?? new Map<string, string>();
    const next = new Map<string, string>();
    for (const summary of summaries) {
      const attention = summary.attention;
      if (summary.terminalId !== DEFAULT_TERMINAL_ID || !attention) continue;
      const threadId = summary.threadId as ThreadId;
      next.set(threadId, attention.at);
      if (firstSight || previous.get(threadId) === attention.at) continue;
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (!thread || thread.archivedAt !== null) continue;
      const failed = attention.kind === "finished" && (attention.exitCode ?? 0) !== 0;
      notifyTerminalThread({
        environmentId,
        threadId,
        threadTitle: thread.title,
        outcome: attention.kind === "bell" ? "input" : failed ? "failed" : "done",
        viewing: activeThreadId() === threadId,
        router,
        trackNotification,
      });
    }
    seen = next;
  };

  const unsubscribes = [
    registry.subscribe(summariesAtom, observe),
    registry.subscribe(shellAtom, observe, { immediate: true }),
    // Fork: `inAppNotificationClosesOnOpen` for agent and terminal threads of this environment.
    router.subscribe("onResolved", () => {
      const threadId = activeThreadId();
      if (threadId) closeThreadToasts(environmentId, threadId as ThreadId);
    }),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

const OUTCOME_PRESENTATION = {
  input: {
    title: "Input needed",
    toastType: "warning",
    icon: <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />,
  },
  done: {
    title: "Program done",
    toastType: "success",
    icon: <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />,
  },
  failed: {
    title: "Program failed",
    toastType: "error",
    icon: <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />,
  },
} as const;

function notifyTerminalThread(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly outcome: keyof typeof OUTCOME_PRESENTATION;
  readonly viewing: boolean;
  readonly router: AnyRouter;
  readonly trackNotification: TrackNotification;
}) {
  const { environmentId, threadId, threadTitle, router, trackNotification } = input;
  const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
  const { title, toastType, icon } = OUTCOME_PRESENTATION[input.outcome];
  const openThread = () =>
    void router.navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  if (hasNotificationSound(mode)) {
    void playNotificationSound(input.outcome === "input" ? "input" : "completion", () =>
      hasNotificationSound(getClientSettings().notificationMode),
    );
  }
  const focused = document.visibilityState === "visible" && document.hasFocus();
  if (inAppNotificationsEnabled && focused && !input.viewing) {
    const toastId = addThreadToast(
      { environmentId, threadId },
      input.outcome === "done" ? "completion" : "attention",
      {
        type: toastType,
        title,
        description: threadTitle,
        data: { hideCopyButton: true, leadingIcon: icon },
        actionProps: {
          children: "Open thread",
          onClick: () => {
            if (toastId !== null) toastManager.close(toastId);
            openThread();
          },
        },
      },
    );
    return;
  }
  if (
    !hasDesktopNotifications(mode) ||
    focused ||
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  const tag = threadNotificationTag(environmentId, threadId);
  try {
    const notification = new Notification(title, { body: threadTitle, tag, silent: true });
    trackNotification(environmentId, notification);
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
      void window.desktopBridge?.revealWindow?.().catch(() => undefined);
      openThread();
    });
  } catch {
    // Some browsers expose Notification but reject desktop presentation.
    void showInstalledAppNotification(
      title,
      { body: threadTitle, tag, url: `/${environmentId}/${threadId}` },
      openThread,
    )
      .then((shown) => {
        if (shown) trackNotification(environmentId, shown, "replacedByTag");
      })
      .catch(() => undefined);
  }
}
