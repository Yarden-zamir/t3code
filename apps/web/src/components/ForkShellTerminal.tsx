import {
  AuthTerminalOperateScope,
  DEFAULT_TERMINAL_ID,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { terminalThreadLaunch } from "@t3tools/shared/terminalThreadLaunch";
import * as Schema from "effect/Schema";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../appearanceFonts";
import { useGrabTerminalFocus } from "../hooks/useForkTerminalFocus";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";
import { useEnvironmentScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import { TerminalViewport } from "./ThreadTerminalDrawer";
import { Button } from "./ui/button";

/** The title of a terminal thread that no command named yet. */
export const TERMINAL_THREAD_DEFAULT_TITLE = "Terminal";
export const TERMINAL_TITLE_MAX_CHARS = 80;

type SessionStatus = Parameters<
  NonNullable<Parameters<typeof TerminalViewport>[0]["onStatusChange"]>
>[0];

/**
 * Fork: the shell of a terminal thread, or of a draft in Terminal mode: the main terminal
 * `term-1` with focus on mount and the ended state. When the shell exits, the server closes the
 * session and keeps its output; Start a new shell (or Enter) opens a fresh shell below it, and
 * every client that shows the terminal follows, because the state comes from the server.
 */
export function ForkShellTerminal(props: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly shell: string | undefined;
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
  const ended = status === "exited" || status === "closed";
  const { onEndedChange } = props;
  useEffect(() => onEndedChange?.(ended), [ended, onEndedChange]);
  const restart = () => {
    if (restarting || !canOperate) return;
    setRestarting(true);
    // `.finally`, not `try`/`finally`: React Compiler skips a component with `try`/`finally`.
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: launch.cwd,
        worktreePath: launch.worktreePath,
        env: { ...launch.env },
        ...(props.shell ? { shell: props.shell } : {}),
      },
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
        if (!ended || event.key !== "Enter") return;
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
          <span className="text-muted-foreground">{props.endedMessage ?? "The shell exited."}</span>
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
