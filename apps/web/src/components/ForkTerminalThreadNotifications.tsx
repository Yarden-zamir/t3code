import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_TERMINAL_ID, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { CircleAlertIcon, CircleCheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { addThreadToast, closeThreadToasts } from "../forkInAppNotifications";
import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { showInstalledAppNotification } from "../installedApp";
import { environmentShell } from "../state/shell";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  threadNotificationTag,
} from "../threadNotifications";
import type { OnNotification } from "./ThreadNotificationCoordinator";
import { toastManager } from "./ui/toast";

/**
 * Fork: notifications for terminal threads (`forkTerminalThreads.ts`), which have no agent runs
 * to notify about. A bell or an app notification asks for input; a program that ends completes,
 * or fails with a non-zero exit code. Same sound, toast and desktop rules as agent threads
 * (`ThreadNotificationCoordinator`), copied here so that the upstream presenter stays unchanged.
 */
export function ForkTerminalThreadNotifications(props: {
  readonly environmentId: EnvironmentId;
  readonly onNotification: OnNotification;
}) {
  const { environmentId, onNotification } = props;
  const sessions = useKnownTerminalSessions({ environmentId, threadId: null });
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : null;
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  // The attention that each thread had last time; the first sight of a thread only records it.
  const seen = useRef<Map<string, string> | null>(null);

  // Fork: `inAppNotificationClosesOnOpen` for agent and terminal threads of this environment.
  useEffect(() => {
    if (activeEnvironmentId !== environmentId || !activeThreadId) return;
    closeThreadToasts(environmentId, activeThreadId as ThreadId);
  }, [activeEnvironmentId, activeThreadId, environmentId]);

  useEffect(() => {
    if (sessions === null || threads === null) return;
    const firstSight = seen.current === null;
    const previous = seen.current ?? new Map<string, string>();
    const next = new Map<string, string>();
    for (const session of sessions) {
      const summary = session.state.summary;
      if (session.target.terminalId !== DEFAULT_TERMINAL_ID || !summary?.attention) continue;
      const threadId = session.target.threadId as ThreadId;
      const attention = summary.attention;
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
        mode,
        inAppNotificationsEnabled,
        viewing: activeEnvironmentId === environmentId && activeThreadId === threadId,
        navigate,
        onNotification,
      });
    }
    seen.current = next;
  }, [
    activeEnvironmentId,
    activeThreadId,
    environmentId,
    inAppNotificationsEnabled,
    mode,
    navigate,
    onNotification,
    sessions,
    threads,
  ]);

  return null;
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
  readonly mode: ReturnType<typeof getClientSettings>["notificationMode"];
  readonly inAppNotificationsEnabled: boolean;
  readonly viewing: boolean;
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly onNotification: OnNotification;
}) {
  const { environmentId, threadId, threadTitle, mode, navigate, onNotification } = input;
  const { title, toastType, icon } = OUTCOME_PRESENTATION[input.outcome];
  const openThread = () =>
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  if (hasNotificationSound(mode)) {
    void playNotificationSound(input.outcome === "input" ? "input" : "completion", () =>
      hasNotificationSound(getClientSettings().notificationMode),
    );
  }
  const focused = document.visibilityState === "visible" && document.hasFocus();
  if (input.inAppNotificationsEnabled && focused && !input.viewing) {
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
    onNotification(environmentId, notification);
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
        if (shown) onNotification(environmentId, shown, "replacedByTag");
      })
      .catch(() => undefined);
  }
}
