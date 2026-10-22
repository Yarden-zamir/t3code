import {
  DEFAULT_TERMINAL_ID,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { terminalThreadLaunch } from "@t3tools/shared/terminalThreadLaunch";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../appearanceFonts";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { observeResize } from "../lib/observeResize";
import { TerminalViewport } from "./ThreadTerminalDrawer";
import { Button } from "./ui/button";

/**
 * Fork: the main view of a terminal thread (`forkTerminalThreads.ts`).
 *
 * Limit: the view covers the timeline and the composer, which stay mounted, so ChatView keeps
 * one small change. They hold nothing, because a terminal thread has no turns. Revisit if the
 * hidden composer takes focus or the timeline costs time.
 */
export function ForkTerminalThreadView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly keybindings: ResolvedKeybindingsConfig;
}) {
  const { threadRef, workspaceRoot, worktreePath } = props;
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const launch = terminalThreadLaunch({ workspaceRoot, worktreePath });
  // Attention that the user sees counts as a visit on the server, so every client clears it. A
  // window without focus marks it when it gets focus.
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const attentionAt = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  })?.find((known) => known.target.terminalId === DEFAULT_TERMINAL_ID)?.state.summary?.attention
    ?.at;
  useEffect(() => {
    if (attentionAt === undefined) return;
    const markSeen = () => {
      if (!document.hasFocus()) return;
      void visitThread({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, visitedAt: new Date().toISOString() },
      });
    };
    markSeen();
    window.addEventListener("focus", markSeen);
    return () => window.removeEventListener("focus", markSeen);
  }, [attentionAt, threadRef, visitThread]);

  // The server closes the session when the shell exits. The next viewport opens a fresh one.
  const [session, setSession] = useState({ id: 0, ended: false });

  // The viewport refits on a change of these numbers, so a sidebar or window resize refits it.
  const containerRef = useRef<HTMLDivElement>(null);
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
      data-terminal-thread-view
      className="absolute inset-0 z-30 flex min-h-0 min-w-0 bg-(--terminal-background) p-2"
    >
      <TerminalViewport
        key={session.id}
        advancedTypography={advancedTypography}
        threadRef={threadRef}
        threadId={threadRef.threadId}
        terminalId={DEFAULT_TERMINAL_ID}
        terminalLabel="Terminal"
        cwd={launch.cwd}
        worktreePath={launch.worktreePath}
        runtimeEnv={launch.env}
        onSessionExited={() => setSession((current) => ({ ...current, ended: true }))}
        focusRequestId={1}
        autoFocus
        visible
        resizeEpoch={layout.epoch}
        drawerHeight={layout.height}
        keybindings={props.keybindings}
      />
      {session.ended ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-(--terminal-background)/80">
          <p className="text-sm text-muted-foreground">The shell exited. The session is closed.</p>
          <Button
            autoFocus
            onClick={() => setSession((current) => ({ id: current.id + 1, ended: false }))}
          >
            Start a new session
          </Button>
        </div>
      ) : null}
    </div>
  );
}
