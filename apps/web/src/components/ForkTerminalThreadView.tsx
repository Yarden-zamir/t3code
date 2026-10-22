import {
  type ClientSettings,
  DEFAULT_TERMINAL_ID,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  TERMINAL_THREAD_ENV,
  TERMINAL_THREAD_FIND_SEQUENCE,
  terminalThreadSuperKeyWire,
} from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import * as Schema from "effect/Schema";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import {
  resolveTerminalFontSizePreference,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../appearanceFonts";
import { useClientSettings } from "../hooks/useSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useStableCallback } from "../hooks/useStableCallback";
import { observeResize } from "../lib/observeResize";
import { isMacPlatform } from "../lib/utils";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import { TerminalViewport } from "./ThreadTerminalDrawer";

/**
 * Fork: the find shortcut of a terminal thread. `cmd+f` on macOS. Elsewhere `ctrl+shift+f`,
 * because `ctrl+f` is page-down in vim and forward-char in the shell.
 */
export function isTerminalThreadFindShortcut(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): boolean {
  if (event.key.toLowerCase() !== "f" || event.altKey) return false;
  return isMacPlatform(navigator.platform)
    ? event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey;
}

const TERMINAL_THREAD_ZOOM_STORAGE_KEY = "t3code:terminal-thread-font-delta";
const selectZoomLimits = (settings: ClientSettings) => ({
  min: settings.terminalThreadFontSizeMin,
  max: settings.terminalThreadFontSizeMax,
});

type TerminalThreadZoom = "in" | "out" | "reset";

/** Fork: `cmd+=`, `cmd+-` and `cmd+0` on macOS, `ctrl+shift+=`, `ctrl+shift+-` and `ctrl+0` elsewhere. */
export function terminalThreadZoomShortcut(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): TerminalThreadZoom | null {
  if (event.altKey) return null;
  const mac = isMacPlatform(navigator.platform);
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null;
  if (event.key === "0") return "reset";
  if (event.key === "-" || event.key === "_") return "out";
  if (event.key === "=" || event.key === "+") return "in";
  return null;
}

const TERMINAL_THREAD_FIND_EVENT = "t3:terminal-thread-find-open";

/** Fork: asks the open terminal thread view to open its search, as `requestThreadFindOpen` does. */
export function requestTerminalThreadFindOpen(): void {
  window.dispatchEvent(new Event(TERMINAL_THREAD_FIND_EVENT));
}

/** Fork: opens the tmux search prompt of a terminal thread. */
export function useTerminalThreadFind(threadRef: ScopedThreadRef | null) {
  const runTerminalWrite = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  return useStableCallback(() => {
    if (threadRef === null) return;
    void runTerminalWrite({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        terminalId: DEFAULT_TERMINAL_ID,
        data: TERMINAL_THREAD_FIND_SEQUENCE,
      },
    });
  });
}

/**
 * Fork: the main view of a terminal thread (`forkTerminalThreads.ts`). The server runs this
 * terminal inside the thread's tmux session.
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
  const cwd = projectScriptCwd({ project: { cwd: workspaceRoot }, worktreePath });
  const runtimeEnv = {
    ...projectScriptRuntimeEnv({ project: { cwd: workspaceRoot }, worktreePath }),
    [TERMINAL_THREAD_ENV]: "1",
  };
  const limits = useClientSettings(selectZoomLimits);
  const baseFontSize = useClientSettings((settings) =>
    resolveTerminalFontSizePreference({
      advanced: advancedTypography,
      code: settings.fontSizeCode,
      terminal: settings.fontSizeTerminal,
    }),
  );
  const [zoomDelta, setZoomDelta] = useLocalStorage(
    TERMINAL_THREAD_ZOOM_STORAGE_KEY,
    0,
    Schema.Int,
  );
  const openFind = useTerminalThreadFind(threadRef);
  useEffect(() => {
    window.addEventListener(TERMINAL_THREAD_FIND_EVENT, openFind);
    return () => window.removeEventListener(TERMINAL_THREAD_FIND_EVENT, openFind);
  }, [openFind]);

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

  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const zoom = terminalThreadZoomShortcut(event);
    if (zoom !== null) {
      event.preventDefault();
      event.stopPropagation();
      const next = baseFontSize + zoomDelta + (zoom === "in" ? 1 : -1);
      setZoomDelta(
        zoom === "reset" ? 0 : Math.min(limits.max, Math.max(limits.min, next)) - baseFontSize,
      );
      return;
    }
    if (!isTerminalThreadFindShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    openFind();
  };

  return (
    <div
      ref={containerRef}
      data-terminal-thread-view
      className="absolute inset-0 z-30 flex min-h-0 min-w-0 bg-(--terminal-background) p-2"
      onKeyDownCapture={handleKeyDownCapture}
    >
      <TerminalViewport
        advancedTypography={advancedTypography}
        threadRef={threadRef}
        threadId={threadRef.threadId}
        terminalId={DEFAULT_TERMINAL_ID}
        terminalLabel="Terminal"
        cwd={cwd}
        worktreePath={worktreePath}
        runtimeEnv={runtimeEnv}
        superKeyWire={terminalThreadSuperKeyWire}
        fontSizeDelta={
          Math.min(limits.max, Math.max(limits.min, baseFontSize + zoomDelta)) - baseFontSize
        }
        onSessionExited={() => undefined}
        focusRequestId={1}
        autoFocus
        visible
        resizeEpoch={layout.epoch}
        drawerHeight={layout.height}
        keybindings={props.keybindings}
      />
    </div>
  );
}
