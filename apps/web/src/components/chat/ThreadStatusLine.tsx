import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  forkEffectiveSnoozed,
  forkThreadWokeAt,
  type TerminalThreadState,
} from "@t3tools/client-runtime/state/fork-terminal-threads";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { AlarmClockIcon, CheckCircle2Icon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useAcknowledgeThreadWoke } from "../../hooks/useThreadActions";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { formatRelativeTimeLabel, formatRelativeTimeUntilLabel } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import { isThreadWokeUnseen } from "../ChatView.logic";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { InlineButton } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

function ThreadStatusLine(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly actionLabel: string;
  readonly actionDisabled?: boolean;
  readonly onAction: () => void;
  // Set when the label reads the clock, so the line updates as time passes.
  readonly clockMinute?: string;
}) {
  return (
    <div
      data-chat-thread-status-line="true"
      className="mx-auto flex w-full min-w-0 max-w-(--chat-content-max-width) items-center gap-1.5 px-1 pb-2 text-muted-foreground text-xs [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {props.icon}
      <span className="min-w-0 truncate">{props.label}</span>
      <span aria-hidden="true">·</span>
      <InlineButton tone="muted" disabled={props.actionDisabled} onClick={props.onAction}>
        {props.actionLabel}
      </InlineButton>
    </div>
  );
}

/**
 * The snoozed, settled and woke state of a thread, with the line that shows it and lets the user
 * wake, un-settle or dismiss. Shared by ChatView and the terminal thread screen.
 */
export function useThreadStatusLine(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly thread: EnvironmentThreadShell | null;
  // Fork: the main terminal of a terminal thread. A bell or an ended program wakes it.
  readonly terminal: TerminalThreadState | undefined;
  readonly latestRunCompletedAt: string | null;
  readonly supportsSnooze: boolean;
  readonly supportsSettlement: boolean;
  readonly canOperate: boolean;
}) {
  const { threadRef, thread, terminal } = input;
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  // The compiler caches render results on their inputs, so a clock read in render
  // stays frozen until the shell changes. The clock is state: reset with the shell,
  // and moved by the wake timer.
  const [snoozeClockState, setSnoozeClockState] = useState(() => ({
    shell: thread,
    now: new Date().toISOString(),
  }));
  if (snoozeClockState.shell !== thread) {
    setSnoozeClockState({ shell: thread, now: new Date().toISOString() });
  }
  const snoozeClock = snoozeClockState.now;
  const snoozed =
    thread !== null &&
    input.supportsSnooze &&
    forkEffectiveSnoozed(thread, { now: snoozeClock }, terminal);
  useEffect(() => {
    if (!snoozed) return;
    const wakeAtMs = Date.parse(thread?.snoozedUntil ?? "");
    if (!Number.isFinite(wakeAtMs)) return;
    const id = window.setTimeout(
      () => setSnoozeClockState((clock) => ({ ...clock, now: new Date().toISOString() })),
      Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(id);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A clock that lands before the wake time (timer clamping, clock skew) re-arms the timer.
  }, [thread?.snoozedUntil, snoozed, snoozeClock]);
  const wokeAt =
    thread !== null && input.supportsSnooze
      ? forkThreadWokeAt(thread, { now: snoozeClock }, terminal)
      : null;
  const acknowledgeThreadWoke = useAcknowledgeThreadWoke();
  const acknowledgeWoke = () => {
    if (threadRef === null || wokeAt === null) return;
    acknowledgeThreadWoke(threadRef, wokeAt);
  };
  const acknowledgeWokeStable = useStableCallback(acknowledgeWoke);
  const localVisitedAt = useUiStateStore((store) =>
    threadKey === null ? undefined : store.threadLastVisitedAtById[threadKey],
  );
  const lastVisitedAt = resolveThreadLastVisitedAt(thread?.lastVisitedAt, localVisitedAt);
  const wokeVisible = isThreadWokeUnseen({
    wokeAt,
    settled: thread?.settledOverride === "settled",
    lastVisitedAt,
    latestRunCompletedAt: input.latestRunCompletedAt,
  });
  const settled = input.supportsSettlement && thread?.settledOverride === "settled";
  const unsettleThreadMutation = useOrchestrationCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
  const [unsettlingThreadKey, setUnsettlingThreadKey] = useState<string | null>(null);
  const isUnsettling = unsettlingThreadKey !== null && unsettlingThreadKey === threadKey;
  const unsettle = async () => {
    if (!threadRef || !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope))
      return;
    const key = scopedThreadKey(threadRef);
    setUnsettlingThreadKey(key);
    // Commands settle into a result, so this always runs.
    const result = await unsettleThreadMutation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, reason: "user" },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to un-settle thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    setUnsettlingThreadKey((current) => (current === key ? null : current));
  };
  const unsettleStable = useStableCallback(unsettle);
  const unsnoozeThreadMutation = useOrchestrationCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [unsnoozingThreadKey, setUnsnoozingThreadKey] = useState<string | null>(null);
  const isUnsnoozing = unsnoozingThreadKey !== null && unsnoozingThreadKey === threadKey;
  const unsnooze = async () => {
    if (!threadRef || !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope))
      return;
    const key = scopedThreadKey(threadRef);
    setUnsnoozingThreadKey(key);
    // Commands settle into a result, so this always runs.
    const recovery = thread?.limitRecovery;
    const recoveryOwnsSnooze =
      recovery?.snooze === true &&
      recovery.runId === thread?.latestRun?.runId &&
      thread?.snoozedUntil != null &&
      Date.parse(thread.snoozedUntil) === Date.parse(recovery.resetAt);
    const result = recoveryOwnsSnooze
      ? await updateThreadMetadata({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            limitRecovery: { runId: recovery.runId, resetAt: recovery.resetAt, snooze: false },
          },
        })
      : await unsnoozeThreadMutation({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, reason: "user" },
        });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to wake thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    setUnsnoozingThreadKey((current) => (current === key ? null : current));
  };
  const unsnoozeStable = useStableCallback(unsnooze);
  const nowMinute = useNowMinute();
  // The relative times read the clock; nowMinute re-renders them on the minute.
  const snoozedUntil = thread?.snoozedUntil ?? null;
  const settledAt = thread?.settledAt ?? null;
  const line = snoozed ? (
    <ThreadStatusLine
      icon={<AlarmClockIcon />}
      label={snoozedUntil ? `Snoozed, ${formatRelativeTimeUntilLabel(snoozedUntil)}` : "Snoozed"}
      clockMinute={nowMinute}
      actionLabel={isUnsnoozing ? "Waking..." : "Wake now"}
      actionDisabled={!input.canOperate || isUnsnoozing}
      onAction={() => void unsnoozeStable()}
    />
  ) : settled ? (
    <ThreadStatusLine
      icon={<CheckCircle2Icon />}
      label={settledAt ? `Settled ${formatRelativeTimeLabel(settledAt)}` : "Settled"}
      clockMinute={nowMinute}
      actionLabel={isUnsettling ? "Un-settling..." : "Un-settle"}
      actionDisabled={!input.canOperate || isUnsettling}
      onAction={() => void unsettleStable()}
    />
  ) : wokeVisible ? (
    <ThreadStatusLine
      icon={<AlarmClockIcon />}
      label="Woke from snooze"
      actionLabel="Dismiss"
      onAction={acknowledgeWokeStable}
    />
  ) : null;

  return { settled, unsettle: unsettleStable, acknowledgeWoke, line };
}
