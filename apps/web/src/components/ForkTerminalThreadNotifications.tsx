import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_TERMINAL_ID, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useEffect, useRef } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { environmentShell } from "../state/shell";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { notifyThread, type OnNotification } from "./ThreadNotificationCoordinator";

/**
 * Fork: notifications for terminal threads (`forkTerminalThreads.ts`), which have no agent runs
 * to notify about. A bell or an app notification asks for input; a program that ends completes,
 * or fails with a non-zero exit code. Same sound, toast and desktop rules as agent threads.
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
      notifyThread({
        environmentId,
        threadId,
        threadTitle: thread.title,
        kind: attention.kind === "bell" ? "input" : "completion",
        status: failed ? "failed" : attention.kind === "bell" ? "input" : "ready",
        title:
          attention.kind === "bell" ? "Input needed" : failed ? "Program failed" : "Program done",
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
