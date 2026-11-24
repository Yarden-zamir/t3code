import type {
  IdleCompactionMode,
  IdleCompactionSource,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  type LimitPace,
  type LimitPoolWindow,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { Link } from "@tanstack/react-router";
import { msg, useGT, useLocale, useMessages } from "gt-react";
import type { ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { useNavigate } from "@tanstack/react-router";
import { copyFromObjectMenu, showObjectMenu } from "../../objectMenu";
import { Button } from "../ui/button";
import { ShortcutCommandRows } from "../focusLevels/ShortcutHint";
import {
  deriveThreadDetailsIdleCompaction,
  nextPoolReset,
  poolSources,
  resolveThreadDetailsLimits,
  resolveThreadHttpQuotas,
} from "./ThreadDetailsUsage.logic";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
};

const IDLE_COMPACTION_MODE_TEXT: Record<IdleCompactionMode, string> = {
  onReturn: msg("Compacts when you return"),
  beforeCacheExpires: msg("Compacts before the cache expires"),
  off: msg("Never compacts while idle"),
};

const IDLE_COMPACTION_SOURCE_TEXT: Record<IdleCompactionSource, string> = {
  project: msg("from project", { $context: "where the idle compaction mode is set" }),
  provider: msg("from provider", { $context: "where the idle compaction mode is set" }),
  environment: msg("from environment", { $context: "where the idle compaction mode is set" }),
};

/** A Claude thread's idle compaction mode in force, with what the client needs to show its state. */
export interface ThreadDetailsIdleCompactionInput {
  readonly mode: IdleCompactionMode;
  readonly source: IdleCompactionSource;
  readonly promptCacheExpiresAt: string | null;
  readonly idle: boolean;
  /** Whether "Compact now" can run; the chat's own compact command checks the same state. */
  readonly canCompact: boolean;
  /** Opens the project's select for this mode, or null when the thread has no project to open. */
  readonly onChangeForProject: (() => void) | null;
}

export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly model: string | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
  /** Null for threads that are not on Claude. */
  readonly idleCompaction: ThreadDetailsIdleCompactionInput | null;
}

type UsageTone = "error" | "warning" | null;

function limitTone(left: number): UsageTone {
  if (left <= 10) return "error";
  if (left <= 20) return "warning";
  return null;
}

/** The selected provider's limit windows. Each row reads as room left and opens the usage page. */
export function ThreadDetailsUsage({
  providerInstanceId,
  model,
  providers,
  sources,
}: Omit<ThreadDetailsUsageInput, "contextWindow" | "idleCompaction">) {
  const gt = useGT();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const resolved = resolveThreadDetailsLimits(providerInstanceId, model, providers, sources, now);
  const m = useMessages();
  const forkUsageMenu = useForkUsageMenu();
  const quotas = resolveThreadHttpQuotas(providerInstanceId, sources);
  if (!resolved && quotas.length === 0) return null;
  // Fork: the text that the context menu copies.
  const resolvedLines = !resolved
    ? []
    : resolved.kind === "pool"
      ? resolved.windows.map((window) => `${window.label}: ${window.remainingPercent}% left`)
      : limitsNotice(resolved.limits, m)
        ? []
        : resolved.limits.windows.map(
            (window) => `${window.label}: ${remainingPercent(window)}% left`,
          );
  const usageText = [
    ...resolvedLines,
    ...quotas.map(
      ({ accountLabel, window }) =>
        `${accountLabel} ${window.label}: ${remainingPercent(window)}% left`,
    ),
  ].join("\n");

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title={gt("Usage limits")}
      showHeading={false}
      onContextMenu={(event) => forkUsageMenu(event, usageText)}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {resolved?.kind === "pool"
          ? resolved.windows.map((window) => <PoolRow key={window.id} window={window} now={now} />)
          : resolved &&
            (quotas.length === 0 || limitsNotice(resolved.limits) === null) && (
              <InstanceRows limits={resolved.limits} now={now} />
            )}
        {quotas.map(({ key, accountLabel, window }) => (
          <LimitRow key={key} window={window} now={now} accountLabel={accountLabel} />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}

function InstanceRows({
  limits,
  now,
}: {
  readonly limits: ServerProviderUsageLimits;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const notice = limitsNotice(limits, m);
  if (notice) {
    return (
      <UsageRow
        label={gt("Limits", { $context: "usage limits row label" })}
        fill={null}
        tone={null}
        value={gt("Unavailable")}
        tooltip={<span className="text-foreground">{notice}</span>}
        opensUsage
      />
    );
  }
  return limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />);
}

/** The thread's context window. The bar fills as context is used; the tick marks auto-compaction. */
export function ThreadDetailsContext({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const tick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  const forkUsageMenu = useForkUsageMenu();
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title={gt("Context window")}
      showHeading={false}
      onContextMenu={(event) => forkUsageMenu(event, `Context: ${usedTokens}`)}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label={gt("Context", { $context: "context window row label" })}
          fill={used}
          tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
          tick={tick}
          muted
          value={
            maxTokens !== null
              ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}`
              : usedTokens
          }
          ariaValue={
            used !== null
              ? gt("{used}% used", { used })
              : gt("{usedTokens} tokens used", { usedTokens })
          }
          tooltip={
            <>
              <span className="text-foreground">
                {used !== null
                  ? gt("Context: {used}% used", { used })
                  : gt("Context: {usedTokens} tokens used", { usedTokens })}
              </span>
              {maxTokens !== null ? (
                <span className="text-muted-foreground">
                  {gt("{used} of {max} tokens", {
                    used: usage.usedTokens.toLocaleString(locale),
                    max: maxTokens.toLocaleString(locale),
                  })}
                </span>
              ) : null}
              {threshold !== null && threshold > 0 ? (
                <span className="text-muted-foreground">
                  {formatContextWindowCompactionMessage(threshold, m)}
                </span>
              ) : null}
            </>
          }
        />
      </div>
    </ThreadDetailsSection>
  );
}

/** Fork: the prompt cache and idle compaction of a Claude thread. Ticks once per minute. */
export function ThreadDetailsPromptCache({
  input,
  usedTokens,
}: {
  readonly input: ThreadDetailsIdleCompactionInput;
  readonly usedTokens: number | null;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  // Limit: `now` is the start of the minute, so times can be up to 59 s off. Revisit if the row shows seconds.
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const state = deriveThreadDetailsIdleCompaction({ ...input, usedTokens, now });
  const value =
    state.cache?.kind === "warm"
      ? formatDuration(state.cache.expiresAt - now, m)
      : state.cache?.kind === "expired"
        ? gt("Expired", { $context: "prompt cache state" })
        : gt("Unknown", { $context: "prompt cache state" });
  return (
    <ThreadDetailsSection
      headingId="thread-details-prompt-cache-heading"
      title={gt("Prompt cache")}
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label={gt("Cache", { $context: "prompt cache row label" })}
          fill={null}
          tone={null}
          value={value}
          tooltip={
            <>
              {state.cache?.kind === "warm" ? (
                <span className="text-foreground">
                  {gt("Prompt cache warm, expires in {duration}", {
                    duration: formatDuration(state.cache.expiresAt - now, m),
                  })}
                </span>
              ) : state.cache?.kind === "expired" ? (
                <span className="text-foreground">{gt("Prompt cache expired")}</span>
              ) : null}
              <span className="text-muted-foreground">
                {gt("{mode}, {source}", {
                  mode: m(IDLE_COMPACTION_MODE_TEXT[state.mode]),
                  source: m(IDLE_COMPACTION_SOURCE_TEXT[state.source]),
                })}
              </span>
              {state.compactsAt !== null ? (
                <span className="text-muted-foreground">
                  {gt("Compacts at {time}", {
                    time: formatUpcomingTimestamp(
                      new Date(state.compactsAt).toISOString(),
                      timestampFormat,
                      now,
                      undefined,
                      m,
                    ),
                  })}
                </span>
              ) : null}
              {input.canCompact ? (
                <ShortcutCommandRows
                  commands={[{ command: "chat.compactContext", name: gt("Compact now") }]}
                />
              ) : null}
              {input.onChangeForProject ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="-mx-1 justify-start"
                  onClick={input.onChangeForProject}
                >
                  <span className="text-muted-foreground">{gt("Change for this project…")}</span>
                </Button>
              ) : null}
            </>
          }
        />
      </div>
    </ThreadDetailsSection>
  );
}

/** Fork: the right-click menu of the usage rows: open the Usage page, copy the shown values. */
function useForkUsageMenu() {
  const navigate = useNavigate();
  const gt = useGT();
  return (event: Parameters<typeof showObjectMenu>[0], usageText: string) =>
    showObjectMenu(event, [
      {
        label: gt("Open usage"),
        keybindingCommand: "usage.open",
        run: () => void navigate({ to: "/usage" }),
      },
      usageText === ""
        ? null
        : {
            label: gt("Copy usage"),
            icon: "copy",
            run: () => copyFromObjectMenu(usageText, gt("Copy usage")),
          },
    ]);
}

function LimitRow({
  window,
  now,
  accountLabel,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly accountLabel?: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={limitTone(left)}
      tick={timeLeft}
      value={`${left}%`}
      ariaValue={gt("{left}% left", { left })}
      opensUsage
      tooltip={
        <>
          <span className="text-foreground">
            {gt("{label}: {left}% left", { label: window.label, left })}
          </span>
          {accountLabel ? <span className="text-muted-foreground">{accountLabel}</span> : null}
          {pace && timeLeft !== null ? (
            <span className="text-muted-foreground">
              {m(PACE_LABEL[pace])} · {gt("{timeLeft}% of the window left", { timeLeft })}
            </span>
          ) : null}
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              {gt("Resets in {duration} · {time}", {
                duration: formatDuration(resetsAt - now, m),
                time: formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m),
              })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

function PoolRow({ window, now }: { readonly window: LimitPoolWindow; readonly now: number }) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = window.remainingPercent;
  const accounts = window.members.length;
  const from = poolSources(window);
  const sourceLabels = [...from.hubs, ...(from.signedIn ? [gt("Signed-in accounts")] : [])];
  const next = nextPoolReset(window, now);
  const resetsAt = next?.member.window.resetsAt;
  const reset =
    next && resetsAt
      ? {
          duration: formatDuration(next.at - now, m),
          time: formatUpcomingTimestamp(resetsAt, timestampFormat, now, undefined, m),
        }
      : null;
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={limitTone(left)}
      value={`${left}%`}
      ariaValue={gt("{left}% left", { left })}
      opensUsage
      tooltip={
        <>
          <span className="text-foreground">
            {accounts > 1
              ? gt("{label}: {left}% left across {accounts} accounts", {
                  label: window.label,
                  left,
                  accounts,
                })
              : gt("{label}: {left}% left", { label: window.label, left })}
          </span>
          {window.pace ? (
            <span className="text-muted-foreground">{m(PACE_LABEL[window.pace])}</span>
          ) : null}
          {next && reset ? (
            <span className="text-muted-foreground">
              {accounts > 1
                ? gt("+{percent}% in {duration} · {time}", {
                    percent: next.restoresPercent,
                    ...reset,
                  })
                : gt("Resets in {duration} · {time}", reset)}
            </span>
          ) : null}
          {sourceLabels.length > 0 ? (
            <span className="text-muted-foreground">
              {gt("From {sources}", { sources: sourceLabels.join(", ") })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. With `opensUsage` it links to the usage page. */
function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  muted = false,
  opensUsage = false,
}: {
  readonly label: string;
  /** Bar fill from 0 to 100. Null hides the bar. */
  readonly fill: number | null;
  readonly tone: UsageTone;
  /** A marker on the bar, from 0 to 100. */
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly muted?: boolean;
  readonly opensUsage?: boolean;
}) {
  const gt = useGT();
  const rowProps = {
    "aria-label": gt("{label}: {value}", { label, value: ariaValue }),
    className: cn(
      "col-span-3 grid h-6 grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]",
      opensUsage
        ? "group cursor-pointer active:bg-black/[0.06] dark:active:bg-white/[0.12]"
        : "cursor-default",
    ),
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          opensUsage ? <Link to="/usage" {...rowProps} /> : <div tabIndex={0} {...rowProps} />
        }
      >
        <span className="max-w-28 truncate text-muted-foreground group-hover:text-foreground">
          {label}
        </span>
        {fill !== null ? (
          <span className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
            {fill > 0 ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  tone === "error"
                    ? "bg-error"
                    : tone === "warning"
                      ? "bg-warning"
                      : muted
                        ? "bg-muted-foreground"
                        : "bg-foreground/80",
                )}
                style={{ width: `max(${fill}%, 6px)` }}
              />
            ) : null}
            {tick !== null ? (
              <span
                aria-hidden
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/75"
                style={{ left: `clamp(0.5px, ${tick}%, calc(100% - 0.5px))` }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            // Text-only rows span the bar column so they never widen the shared value column.
            "text-end font-medium tabular-nums",
            fill === null && "col-span-2",
            tone === "error"
              ? "text-error-foreground"
              : tone === "warning"
                ? "text-warning-foreground"
                : fill === null
                  ? "text-muted-foreground"
                  : "text-foreground/80",
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">
          {tooltip}
          {opensUsage ? <span className="text-muted-foreground">{gt("Open usage")}</span> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
