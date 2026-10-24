import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  DEFAULT_TERMINAL_ID,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  TERMINAL_THREAD_INSTANCE_ID,
} from "@t3tools/contracts";
import { terminalThreadLaunch } from "@t3tools/shared/terminalThreadLaunch";
import * as Schema from "effect/Schema";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../appearanceFonts";
import { terminalThreadOpenInput } from "../forkTerminalThreadOpen";
import { useGrabTerminalFocus } from "../hooks/useForkTerminalFocus";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { terminalShellOptions } from "../lib/forkTerminalProviders";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";
import { providersIgnoringCheckedAtAtom } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { TerminalViewport } from "./ThreadTerminalDrawer";
import { Button } from "./ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type SessionStatus = Parameters<
  NonNullable<Parameters<typeof TerminalViewport>[0]["onStatusChange"]>
>[0];

/**
 * Fork: the shell of a terminal thread, or of a draft in Terminal mode: the main terminal
 * `term-1` with focus on mount and the ended state. When the shell exits, or cannot start, the
 * server keeps the output and writes the reason into it; Start a new shell (or Enter) opens a
 * fresh shell below it, and every client that shows the terminal follows, because the state comes
 * from the server. A thread can pick another shell there, for example when its custom shell was
 * removed; a draft picks its shell in the composer.
 */
export function ForkShellTerminal(props: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly shell: string | undefined;
  /** A draft in Terminal mode, whose shell the server discards once no view holds it. */
  readonly draft?: boolean;
  readonly focusRequestId: number;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onInput?: (data: string) => void;
  readonly className?: string;
  /** Shown over the terminal while the shell is ended, in place of the default message. */
  readonly endedMessage?: ReactNode;
  /** Whether the shell is ended, for a host that changes its own controls then. */
  readonly onEndedChange?: (ended: boolean) => void;
}) {
  const { threadRef } = props;
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const launch = terminalThreadLaunch({
    workspaceRoot: props.workspaceRoot,
    worktreePath: props.worktreePath,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  useGrabTerminalFocus(containerRef);
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);
  const openTerminal = useAtomCommand(terminalEnvironment.open);

  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [restarting, setRestarting] = useState(false);
  const ended = status === "exited" || status === "closed" || status === "error";
  const { onEndedChange } = props;
  useEffect(() => onEndedChange?.(ended), [ended, onEndedChange]);
  const restart = () => {
    if (restarting || !canOperate) return;
    setRestarting(true);
    // `.finally`, not `try`/`finally`: React Compiler skips a component with `try`/`finally`.
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: terminalThreadOpenInput({
        threadId: threadRef.threadId,
        workspaceRoot: props.workspaceRoot,
        worktreePath: props.worktreePath,
        shell: props.shell,
      }),
    }).finally(() => {
      setRestarting(false);
      // The button had focus; the new shell gets it back.
      containerRef.current?.querySelector("textarea")?.focus();
    });
  };

  // The viewport refits on a change of these numbers, so a sidebar or window resize refits it.
  const [layout, setLayout] = useState({ height: 0, epoch: 0 });
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return observeResize(container, (entries) => {
      const entry = entries.at(-1);
      if (!entry) return;
      setLayout((current) => ({
        height: Math.round(entry.contentRect.height),
        epoch: current.epoch + 1,
      }));
    });
  }, []);

  return (
    <div
      ref={containerRef}
      data-terminal-owner="terminal-thread"
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 bg-(--terminal-background)",
        props.className,
      )}
      // A draft terminal grows into this one when it becomes a thread (`ForkDraftTerminalComposer`).
      style={{ viewTransitionName: "t3-fork-terminal" }}
      onKeyDownCapture={(event) => {
        // Only in the terminal: Enter in the shell picker, which the React tree also passes
        // through here from its portal, chooses a shell.
        if (!ended || event.key !== "Enter" || !(event.target instanceof HTMLTextAreaElement)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        restart();
      }}
    >
      <TerminalViewport
        advancedTypography={advancedTypography}
        threadRef={threadRef}
        threadId={threadRef.threadId}
        terminalId={DEFAULT_TERMINAL_ID}
        terminalLabel="Terminal"
        cwd={launch.cwd}
        worktreePath={launch.worktreePath}
        runtimeEnv={launch.env}
        shell={props.shell}
        draft={props.draft}
        onSessionExited={() => {}}
        onStatusChange={setStatus}
        onInput={props.onInput}
        focusRequestId={props.focusRequestId}
        autoFocus
        visible
        resizeEpoch={layout.epoch}
        drawerHeight={layout.height}
        keybindings={props.keybindings}
      />
      {ended ? (
        <div className="absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-center justify-center gap-3 border-t border-border/60 bg-background/90 px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            {status === "error"
              ? "The shell did not start. The terminal shows why."
              : (props.endedMessage ?? "The shell exited.")}
          </span>
          {props.draft || !canOperate ? null : (
            <ThreadShellPicker threadRef={threadRef} shell={props.shell} />
          )}
          {canOperate ? (
            <Button size="sm" disabled={restarting} onClick={restart}>
              Start a new shell
            </Button>
          ) : null}
          {canOperate ? <span className="text-muted-foreground/70">or press Enter</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Fork: marks a custom shell whose executable the server did not find, with the reason on hover.
 * The shell stays selectable: the check uses the PATH of the server, which the terminal extends,
 * and cannot check a relative path. A start that fails shows the same reason in the terminal.
 */
export function ShellNotFoundMark(props: { readonly reason: string | undefined }) {
  if (props.reason === undefined) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="ms-2 text-muted-foreground text-xs" />}>
        not found
      </TooltipTrigger>
      <TooltipPopup>{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The shell of a terminal thread, which is its model. A change takes effect with the next new
 * shell, because the server starts the thread's shell then.
 */
function ThreadShellPicker(props: {
  readonly threadRef: ScopedThreadRef;
  readonly shell: string | undefined;
}) {
  const { threadRef } = props;
  const shells = terminalShellOptions(
    useAtomValue(providersIgnoringCheckedAtAtom(threadRef.environmentId)),
  );
  const canChange = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  // No `shell` means the default shell, which the server lists first.
  const current = props.shell ?? shells.find((shell) => shell.isDefault === true)?.slug;
  if (!canChange || shells.length === 0 || current === undefined) return null;
  const currentShell = shells.find((shell) => shell.slug === current);
  return (
    <Select
      value={current}
      onValueChange={(value: string | null) => {
        if (value === null || value === current) return;
        void updateMetadata({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            modelSelection: { instanceId: TERMINAL_THREAD_INSTANCE_ID, model: value },
          },
        });
      }}
      items={shells.map((shell) => ({ value: shell.slug, label: shell.name }))}
    >
      <SelectTrigger aria-label="Shell of the new shell" className="w-auto min-w-32" size="xs">
        <SelectValue>
          {currentShell === undefined ? `${current} (not defined)` : current}
          {currentShell?.unavailableReason === undefined ? null : " (not found)"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {shells.map((shell) => (
          <SelectItem key={shell.slug} value={shell.slug}>
            {shell.name}
            <ShellNotFoundMark reason={shell.unavailableReason} />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
