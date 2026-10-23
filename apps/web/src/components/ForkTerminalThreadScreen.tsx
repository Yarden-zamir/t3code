import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  DEFAULT_TERMINAL_ID,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  terminalThreadShell,
} from "@t3tools/contracts";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { shortcutLabelForCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";
import { getTerminalFocusOwner, isTerminalThreadShellKey } from "../lib/terminalFocus";
import { cn } from "../lib/utils";
import { useProject, useQuietThreadShell } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { MAX_TERMINALS_PER_GROUP } from "../types";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { ThreadVisitWatermark, useParentThreadLink } from "./ChatView";
import { startNewThreadForProject } from "./ChatView.logic";
import { ChatHeader } from "./chat/ChatHeader";
import { PanelLayoutControls } from "./chat/PanelLayoutControls";
import { type ChatShortcutHandler, useChatShortcuts } from "./chat/useChatShortcuts";
import { focusLevelContext } from "./focusLevels/focusLevels";
import { PersistentThreadTerminalDrawer } from "./PersistentThreadTerminals";
import { useThreadTerminalActions } from "./terminal/useThreadTerminalActions";
import { ForkShellTerminal } from "./ForkShellTerminal";

const NO_PROJECT_SCRIPTS: never[] = [];

/** A pane shortcut that leaves Ctrl chords of the main terminal to its shell. */
const shellKeyOr =
  (run: () => false | void): ChatShortcutHandler =>
  ({ event }) =>
    isTerminalThreadShellKey(event) ? false : run();

/**
 * Fork: the screen of a terminal thread (`forkTerminalThreads.ts`), shown in place of ChatView.
 * The thread header of a normal thread above the main terminal `term-1`. The terminal drawer
 * (`terminal.toggle`) holds the other terminals of the thread.
 */
export function ForkTerminalThreadScreen(props: { readonly threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const navigate = useNavigate();
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const handleNewThread = useNewThreadHandler();
  const drawer = useTerminalThreadDrawer(threadRef);
  const parentThreadLink = useParentThreadLink(thread);
  const terminalShortcutLabel = (command: Parameters<typeof shortcutLabelForCommand>[1]) =>
    shortcutLabelForCommand(keybindings, command, {
      context: { terminalFocus: true, terminalOpen: drawer.open },
    }) ?? undefined;

  useChatShortcuts({
    enabled: true,
    keybindings,
    scriptKeybindings: keybindings,
    getShortcutContext: (target) => ({
      ...focusLevelContext(target),
      terminalFocus: getTerminalFocusOwner() !== null,
      terminalOpen: drawer.open,
      previewFocus: isPreviewFocused(),
      previewOpen: false,
      editableFocus: isEditableFocused(target),
      modelPickerOpen: false,
      isWeb: !isElectron,
      isDesktop: isElectron,
    }),
    threadFindActive: false,
    typeIntoComposer: () => false,
    closeThreadFind: () => {},
    commands: {
      "terminal.toggle": shellKeyOr(() => drawer.toggle()),
      "terminal.new": shellKeyOr(() => drawer.launch("new")),
      "terminal.split": shellKeyOr(() => drawer.launch("split")),
      "terminal.splitVertical": shellKeyOr(() => drawer.launch("splitVertical")),
      // The screen owns `term-1`, so the key never closes it. The viewport decides whether the
      // key goes to the shell (`isTerminalThreadShellKey`) or does nothing.
      "terminal.close": ({ terminalFocusOwner }) =>
        terminalFocusOwner === "drawer" ? drawer.requestCloseActive() : false,
    },
    fallback: () => undefined,
  });

  if (!thread || !project) return null;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header
        className={cn(
          "relative bg-background [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
          isElectron
            ? "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5 wco:pr-(--workspace-native-controls-inset)"
            : "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <ChatHeader
          activeThreadEnvironmentId={thread.environmentId}
          activeThreadId={thread.id}
          isServerThread
          activeThreadTitle={thread.title}
          activeProject={project}
          parentThreadLink={parentThreadLink}
          onOpenThread={(threadId) =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: thread.environmentId, threadId },
            })
          }
          rightPanelOpen={false}
          onNewThreadInProject={() =>
            startNewThreadForProject(
              scopeProjectRef(thread.environmentId, thread.projectId),
              handleNewThread,
            )
          }
          // Pinned scripts run in the chat view's terminals, which this screen does not have.
          projectScripts={NO_PROJECT_SCRIPTS}
          onRunPinnedScript={undefined}
        />
      </header>
      <div
        className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]"
        data-workspace-titlebar-controls
      >
        <div className="pointer-events-auto flex h-full items-center">
          <PanelLayoutControls
            showThreadPanelControl={false}
            showRightPanelControl={false}
            terminalAvailable={drawer.available}
            terminalOpen={drawer.open}
            threadPanelOpen={false}
            threadPanelPresentation="inline"
            rightPanelAvailable={false}
            rightPanelOpen={false}
            onToggleTerminal={drawer.toggle}
            onToggleThreadPanel={() => {}}
            onToggleRightPanel={() => {}}
          />
        </div>
      </div>
      <MainTerminal
        threadRef={threadRef}
        workspaceRoot={project.workspaceRoot}
        worktreePath={thread.worktreePath}
        shell={terminalThreadShell(thread.modelSelection.model)}
        focusRequestId={drawer.mainFocusRequestId}
        keybindings={keybindings}
      />
      <PersistentThreadTerminalDrawer
        threadRef={threadRef}
        threadId={threadRef.threadId}
        active
        launchContext={null}
        focusRequestId={drawer.focusRequestId}
        splitShortcutLabel={terminalShortcutLabel("terminal.split")}
        splitVerticalShortcutLabel={terminalShortcutLabel("terminal.splitVertical")}
        newShortcutLabel={terminalShortcutLabel("terminal.new")}
        closeShortcutLabel={terminalShortcutLabel("terminal.close")}
        keybindings={keybindings}
      />
      <ThreadVisitWatermark threadRef={threadRef} />
    </div>
  );
}

/** The drawer of a terminal thread. It never takes `term-1`, which is the main terminal. */
function useTerminalThreadDrawer(threadRef: ScopedThreadRef) {
  const terminalActions = useThreadTerminalActions(threadRef);
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope);
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);
  const uiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef),
  );
  const store = useTerminalUiStateStore.getState;
  const sessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const drawerSessions = (sessions ?? []).filter(
    (session) => session.target.terminalId !== DEFAULT_TERMINAL_ID,
  );
  const [focusRequestId, setFocusRequestId] = useState(0);
  // Closing the drawer gives focus back to the main terminal.
  const [mainFocusRequestId, setMainFocusRequestId] = useState(1);

  const launch = (place: "new" | "split" | "splitVertical") => {
    if (!canOperate) return false;
    const activeGroup = uiState.terminalGroups.find((group) =>
      group.terminalIds.includes(uiState.activeTerminalId),
    );
    if (place !== "new" && (activeGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP)
      return;
    store().setTerminalOpen(threadRef, true);
    const launched = terminalActions.launchTerminal({
      place: (terminalId) =>
        place === "new"
          ? store().newTerminal(threadRef, terminalId)
          : place === "split"
            ? store().splitTerminal(threadRef, terminalId)
            : store().splitTerminalVertical(threadRef, terminalId),
    });
    if (!launched) return;
    setFocusRequestId((value) => value + 1);
    void launched.result;
  };

  const toggle = () => {
    if (uiState.terminalOpen) {
      store().setTerminalOpen(threadRef, false);
      setMainFocusRequestId((value) => value + 1);
      return;
    }
    if (!canRead && !canOperate) return false;
    if (uiState.terminalIds.length > 0 || !canOperate) {
      store().setTerminalOpen(threadRef, true);
      return;
    }
    // Sessions that another client started exist before this drawer knows them. Reuse one.
    const existing = drawerSessions[0]?.target.terminalId;
    if (existing !== undefined) {
      store().ensureTerminal(threadRef, existing, { open: true, active: true });
      return;
    }
    void terminalActions.launchTerminal({
      place: (terminalId) => store().ensureTerminal(threadRef, terminalId, { open: true }),
    })?.result;
  };

  const requestCloseActive = () => {
    if (!uiState.terminalOpen || !canOperate) return false;
    const terminalId = uiState.activeTerminalId;
    const summary = drawerSessions.find((session) => session.target.terminalId === terminalId)
      ?.state.summary;
    void confirmTerminalClose([resolveTerminalSessionLabel(terminalId, summary ?? null)]).then(
      (confirmed) => {
        if (!confirmed || !readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope))
          return;
        terminalActions.closeTerminalSession(terminalId);
        store().closeTerminal(threadRef, terminalId);
        setFocusRequestId((value) => value + 1);
      },
    );
  };

  return {
    available: canRead || canOperate,
    open: uiState.terminalOpen,
    focusRequestId,
    mainFocusRequestId,
    toggle,
    launch,
    requestCloseActive,
  };
}

/** `term-1` of the thread, and the visit that clears the attention that the user sees. */
function MainTerminal(props: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly shell: string | undefined;
  readonly focusRequestId: number;
  readonly keybindings: ResolvedKeybindingsConfig;
}) {
  const { threadRef } = props;

  // Attention that the user sees counts as a visit on the server, so every client clears it. A
  // window without focus marks it when it gets focus. The visit uses the server time of the
  // attention, because a client clock can be behind it.
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
        input: { threadId: threadRef.threadId, visitedAt: attentionAt },
      });
    };
    markSeen();
    window.addEventListener("focus", markSeen);
    return () => window.removeEventListener("focus", markSeen);
  }, [attentionAt, threadRef, visitThread]);

  return (
    <ForkShellTerminal
      threadRef={threadRef}
      workspaceRoot={props.workspaceRoot}
      worktreePath={props.worktreePath}
      shell={props.shell}
      focusRequestId={props.focusRequestId}
      keybindings={props.keybindings}
      className="p-2"
    />
  );
}
