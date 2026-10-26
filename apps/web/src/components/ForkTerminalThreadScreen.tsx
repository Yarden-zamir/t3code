import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { terminalThreadState } from "@t3tools/client-runtime/state/fork-terminal-threads";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  DEFAULT_TERMINAL_ID,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  terminalThreadCommandTitle,
  TERMINAL_THREADS_SETTING_PATH,
  terminalThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { resolveThreadReferenceCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { Link, useNavigate } from "@tanstack/react-router";
import { use, useEffect, useRef, useState } from "react";

import { BackgroundThreadContext } from "./chat/backgroundThread";
import { isElectron } from "../env";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useLogicalProjectEnvironments } from "../hooks/useLogicalProjectEnvironments";
import { useTerminalThreadsEnabled } from "../hooks/useForkTerminalThreads";
import { useReturnFocusToTerminal } from "../hooks/useForkTerminalFocus";
import { useOpenPanelPullRequestUrl } from "../hooks/useOpenPanelPullRequestUrl";
import { useThreadActions } from "../hooks/useThreadActions";
import { useWorkspaceMutationRefresh } from "../hooks/useWorkspaceMutationRefresh";
import { shortcutLabelForCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";
import {
  focusActiveDrawerTerminal,
  focusTerminal,
  isTerminalFocused,
  isTerminalThreadAppChord,
  isTerminalThreadShellKey,
} from "../lib/terminalFocus";
import { cn } from "../lib/utils";
import { useRemoteOpenState } from "../remoteOpen";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { settleAndAdvance } from "../settleAndAdvance";
import { useProject, useQuietThreadShell } from "../state/entities";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
  serverEnvironment,
} from "../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { MAX_TERMINALS_PER_GROUP } from "../types";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { resolveEffectiveEnvMode } from "./BranchToolbar.logic";
import {
  recallCheckoutIsRepo,
  rememberCheckoutIsRepo,
  startNewThreadForProject,
} from "./ChatView.logic";
import { ChatCanvas } from "./chat/ChatCanvas";
import { composerShortcutCommands } from "./chat/composerShortcuts";
import { ChatHeader } from "./chat/ChatHeader";
import { ComposerBannerStack } from "./chat/ComposerBannerStack";
import { shouldShowOpenInPicker } from "./chat/OpenInPicker.logic";
import { PanelLayoutControls } from "./chat/PanelLayoutControls";
import { ThreadDetailsPanel } from "./chat/ThreadDetailsPanel";
import { ThreadVisitWatermark } from "./chat/ThreadVisitWatermark";
import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
} from "./chat/ThreadErrorBanner";
import { useForkThreadStatusLine } from "./chat/useForkThreadStatusLine";
import { useSystemComposerBanners } from "./chat/useSystemComposerBanners";
import {
  type ChatShortcutCommands,
  type ChatShortcutHandler,
  useChatShortcuts,
} from "./chat/useChatShortcuts";
import {
  ThreadPanelHeaderControl,
  ThreadPanelLayoutControls,
  threadPanelToggleProps,
  ThreadRightPanelHosts,
  ThreadRightPanelView,
  useThreadRightPanel,
} from "./chat/useThreadRightPanel";
import { focusLevelContext } from "./focusLevels/focusLevels";
import { PersistentThreadTerminalDrawer } from "./PersistentThreadTerminals";
import { LinkPullRequestDialogHost } from "./pullRequest/LinkPullRequestDialog";
import { useThreadLinkedPullRequest } from "./pullRequest/useThreadLinkedPullRequest";
import { useThreadTerminalActions } from "./terminal/useThreadTerminalActions";
import { ForkShellTerminal } from "./ForkShellTerminal";
import { PopoverCreateHandle } from "./ui/popover";
import { stackedThreadToast, toastManager } from "./ui/toast";

const NO_PROJECT_SCRIPTS: never[] = [];
const NO_ENVIRONMENTS: never[] = [];

// The screen has no composer or branch toolbar. Their chords reach the shell instead.
const NO_COMPOSER = { current: null };
const NO_BRANCH_TOOLBAR = { current: null };
const COMPOSER_CHORDS_TO_SHELL: ChatShortcutCommands = Object.fromEntries(
  Object.keys(composerShortcutCommands(NO_COMPOSER, NO_BRANCH_TOOLBAR)).map((command) => [
    command,
    () => false,
  ]),
);

/** A pane shortcut that leaves Ctrl chords of the main terminal to its shell. */
const shellKeyOr =
  (run: ChatShortcutHandler): ChatShortcutHandler =>
  (context) =>
    isTerminalThreadShellKey(context.event) ? false : run(context);

const scriptsUnavailable = () =>
  Promise.reject(new Error("Project scripts are not available in a terminal thread."));

/**
 * The script controls of the thread panel. The screen passes no project scripts, which hides
 * them, because scripts run in the chat view's terminal drawer (`ChatView.runProjectScript`).
 * Revisit if a terminal thread runs scripts in its own terminals.
 */
const NO_SCRIPT_ACTIONS = {
  activeProjectScripts: undefined,
  preferredScriptId: null,
  globalScripts: NO_PROJECT_SCRIPTS,
  onRunProjectScript: () => {},
  onRunGlobalScript: () => {},
  onAddProjectScript: scriptsUnavailable,
  onUpdateProjectScript: scriptsUnavailable,
  onDeleteProjectScript: scriptsUnavailable,
};

/**
 * Fork: the screen of a terminal thread (`forkTerminalThreads.ts`), shown in place of ChatView:
 * the thread header above the main terminal `term-1`. The drawer (`terminal.toggle`) holds the
 * other terminals. The right panel and thread panel come from ChatView (`useThreadRightPanel`),
 * without the parts that need a composer.
 */
export function ForkTerminalThreadScreen(props: { readonly threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const navigate = useNavigate();
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const backgroundThread = use(BackgroundThreadContext);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId));
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const handleNewThread = useNewThreadHandler();
  const terminalThreadsEnabled = useTerminalThreadsEnabled(threadRef.environmentId);
  const drawer = useTerminalThreadDrawer(threadRef);
  const parentThreadLink = useParentThreadLink(thread);
  const workspace = useTerminalThreadWorkspace(threadRef, thread, project);
  const [layoutElement, setLayoutElement] = useState<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const [threadPanelPopoverHandle] = useState(PopoverCreateHandle);
  const rightPanel = useThreadRightPanel({
    threadRef,
    routeThreadRef: threadRef,
    project,
    projectId: thread?.projectId ?? null,
    isServerThread: true,
    isGitRepo: workspace.isGitRepo,
    serverConfig,
    pullRequests: thread?.pullRequests ?? [],
    linkedPullRequest: workspace.linkedPullRequest,
    branchPullRequest: thread?.branchPullRequest,
    container: layoutElement,
    terminalLabelsById: workspace.terminalLabelsById,
    gitCwd: workspace.gitCwd,
    onDiffPanelOpen: undefined,
  });
  const threadShortcuts = useThreadShortcuts(threadRef, workspace.linkedPullRequest?.url ?? null);
  const returnFocusToTerminal = useReturnFocusToTerminal({
    headerRef,
    focusMainTerminal: drawer.focusMain,
  });
  const terminalShortcutLabel = (command: Parameters<typeof shortcutLabelForCommand>[1]) =>
    shortcutLabelForCommand(keybindings, command, {
      context: { terminalFocus: true, terminalOpen: drawer.open },
    }) ?? undefined;
  // A Cmd chord in the main terminal is an app shortcut, as for every app listener
  // (`isTerminalFocused`). Without the event (a panel that reads labels), only focus counts.
  const getShortcutContext = (
    target: EventTarget | null = document.activeElement,
    event?: KeyboardEvent,
  ) => ({
    ...focusLevelContext(target),
    terminalFocus: isTerminalFocused(event),
    terminalOpen: drawer.open,
    previewFocus: isPreviewFocused(),
    previewOpen: rightPanel.previewPanelOpen,
    editableFocus: !isTerminalThreadAppChord(event) && isEditableFocused(target),
    modelPickerOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
  });
  const toggleDiff = () => {
    if (!rightPanel.isGitRepo) return false;
    if (rightPanel.rightPanelOpen && rightPanel.activeRightPanelSurface?.kind === "diff") {
      useRightPanelStore.getState().toggle(threadRef, "diff");
      return;
    }
    rightPanel.addDiffSurfaceStable();
  };

  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  useChatShortcuts({
    enabled: !backgroundThread,
    keybindings,
    scriptKeybindings: keybindings,
    getShortcutContext,
    threadFindActive: false,
    composerRef: NO_COMPOSER,
    branchToolbarRef: NO_BRANCH_TOOLBAR,
    // Like the chat composer: a key typed while focus is on the page (after a dialog, a rename or
    // Wake now) goes to the shell, and the shell takes focus.
    typeIntoComposer: (key) => {
      if (!terminalThreadsEnabled) return false;
      if (!readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)) return false;
      void writeTerminal({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, terminalId: DEFAULT_TERMINAL_ID, data: key },
      });
      drawer.focusMain();
      return true;
    },
    closeThreadFind: () => {},
    commands: {
      ...COMPOSER_CHORDS_TO_SHELL,
      "thread.copyReference": shellKeyOr(threadShortcuts.copyReference),
      "thread.settle": shellKeyOr(threadShortcuts.toggleSettled),
      "thread.pin": shellKeyOr(threadShortcuts.togglePinned),
      "rightPanel.toggle": shellKeyOr(() => rightPanel.toggleRightPanelStable()),
      "rightPanel.toggleMaximized": shellKeyOr(({ event }) => {
        if (!event.repeat) rightPanel.toggleRightPanelMaximizedStable();
      }),
      "threadPanel.toggle": () => rightPanel.toggleThreadPanelStable(),
      "rightPanel.close": ({ event }) => {
        const surface = rightPanel.activeRightPanelSurface;
        if (!surface) return false;
        if (!event.repeat) rightPanel.closeRightPanelSurfaceStable(surface);
      },
      "diff.toggle": () => toggleDiff(),
      "terminal.toggle": shellKeyOr(() => drawer.toggle()),
      "terminal.new": shellKeyOr(({ terminalFocusOwner }) => {
        if (terminalFocusOwner !== "right-panel") return drawer.launch("new");
        if (!rightPanel.canOperateTerminal) return false;
        rightPanel.addTerminalSurfaceStable();
      }),
      "terminal.split": shellKeyOr(({ terminalFocusOwner }) => {
        if (terminalFocusOwner !== "right-panel") return drawer.launch("split");
        if (!rightPanel.canOperateTerminal) return false;
        rightPanel.splitPanelTerminalStable();
      }),
      "terminal.splitVertical": shellKeyOr(({ terminalFocusOwner }) => {
        if (terminalFocusOwner !== "right-panel") return drawer.launch("splitVertical");
        if (!rightPanel.canOperateTerminal) return false;
        rightPanel.splitPanelTerminalStable("vertical");
      }),
      // The screen owns `term-1`, so the key never closes it. The viewport decides whether the
      // key goes to the shell (`isTerminalThreadShellKey`) or does nothing.
      "terminal.close": ({ terminalFocusOwner }) => {
        if (terminalFocusOwner === "drawer") return drawer.requestCloseActive();
        const surface = rightPanel.activeRightPanelSurface;
        if (terminalFocusOwner !== "right-panel" || surface?.kind !== "terminal") return false;
        if (!rightPanel.canOperateTerminal) return false;
        rightPanel.requestClosePanelTerminalStable(surface.activeTerminalId);
      },
    },
    fallback: () => undefined,
  });

  if (!thread || !project) return null;

  const panelToggleControlProps = threadPanelToggleProps(rightPanel, {
    terminalAvailable: drawer.available,
    terminalOpen: drawer.open,
    onToggleTerminal: drawer.toggle,
    threadPanelPopoverHandle,
  });
  const panelToggleControls = (
    <PanelLayoutControls
      {...panelToggleControlProps}
      showThreadPanelControl={!rightPanel.inlineRightPanelOwnsTitleBar}
    />
  );
  const panelLayoutControls = (
    <ThreadPanelLayoutControls panel={rightPanel} toggles={panelToggleControls} />
  );
  const noOp = () => {};

  return (
    <div
      ref={setLayoutElement}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      {rightPanel.rightPanelControlsAtRoot ? panelLayoutControls : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          rightPanel.rightPanelMaximized ? "w-0 flex-none" : "flex-1",
        )}
      >
        <header
          ref={headerRef}
          className={cn(
            "relative bg-background [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
            isElectron
              ? cn(
                  "drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center px-3 sm:px-5",
                  !rightPanel.inlineRightPanelOwnsTitleBar &&
                    "wco:pr-(--workspace-native-controls-inset)",
                )
              : "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {isElectron && rightPanel.rightPanelControlsAtRoot ? (
            <span
              aria-hidden
              className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
            />
          ) : null}
          {!rightPanel.rightPanelControlsAtRoot && !rightPanel.rightPanelControlsInPanel
            ? panelLayoutControls
            : null}
          {rightPanel.inlineRightPanelOwnsTitleBar ? (
            <ThreadPanelHeaderControl toggles={panelToggleControlProps} />
          ) : null}
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
            rightPanelOpen={rightPanel.inlineRightPanelOwnsTitleBar}
            onNewThreadInProject={() =>
              startNewThreadForProject(
                scopeProjectRef(thread.environmentId, thread.projectId),
                handleNewThread,
              )
            }
            // Pinned scripts run in the chat view's terminals, which this screen does not have.
            projectScripts={NO_PROJECT_SCRIPTS}
            onRunPinnedScript={undefined}
            onThreadMenuClosed={returnFocusToTerminal}
          />
        </header>
        <TerminalThreadError threadRef={threadRef} thread={thread} />
        {/* The canvas places the floating preview that closing the right panel leaves. */}
        <ChatCanvas composerOverlayElement={null}>
          <MainTerminal
            threadRef={threadRef}
            title={thread.title}
            workspaceRoot={project.workspaceRoot}
            worktreePath={thread.worktreePath}
            shell={terminalThreadShell(thread.modelSelection.model)}
            keybindings={keybindings}
            readOnly={!terminalThreadsEnabled}
          />
          <ThreadRightPanelHosts panel={rightPanel} />
        </ChatCanvas>
        <TerminalThreadNotices threadRef={threadRef} thread={thread} />
        {/* Outside the canvas, the thread details open as a popover and never cover the shell. */}
        <ThreadDetailsPanel
          anchor={headerRef}
          handle={threadPanelPopoverHandle}
          onPresentationChange={rightPanel.setThreadPanelPresentation}
          environmentId={thread.environmentId}
          threadId={thread.id}
          projectId={thread.projectId}
          worktreePath={thread.worktreePath}
          isServerThread
          activeProjectName={project.title}
          keybindings={keybindings}
          availableEditors={availableEditors}
          showOpenInPicker={workspace.showOpenInPicker}
          openInShortcutEnabled={
            !(
              rightPanel.rightPanelOpen &&
              rightPanel.renderedRightPanelSurface?.kind === "file" &&
              rightPanel.renderedRightPanelSurface.attachment === undefined
            )
          }
          gitCwd={workspace.gitCwd}
          isGitRepo={workspace.isGitRepo}
          // A terminal thread has started, so its environment and workspace are fixed.
          envLocked
          availableEnvironments={workspace.environments}
          onEnvironmentChange={noOp}
          onEnvModeChange={noOp}
          envMode={resolveEffectiveEnvMode({
            activeWorktreePath: thread.worktreePath,
            hasServerThread: true,
            draftThreadEnvMode: undefined,
          })}
          startFromOrigin={false}
          onStartFromOriginChange={noOp}
          onComposerFocusRequest={drawer.focusMain}
          {...(workspace.isGitRepo
            ? { onOpenChanges: rightPanel.openChangesFromThreadPanelStable }
            : {})}
          {...NO_SCRIPT_ACTIONS}
        />
        <PersistentThreadTerminalDrawer
          threadRef={threadRef}
          threadId={threadRef.threadId}
          active
          // No composer under the drawer, so it may take the whole column.
          composerHeight={0}
          launchContext={null}
          splitShortcutLabel={terminalShortcutLabel("terminal.split")}
          splitVerticalShortcutLabel={terminalShortcutLabel("terminal.splitVertical")}
          newShortcutLabel={terminalShortcutLabel("terminal.new")}
          closeShortcutLabel={terminalShortcutLabel("terminal.close")}
          keybindings={keybindings}
        />
      </div>
      <ThreadRightPanelView
        panel={rightPanel}
        keybindings={keybindings}
        getShortcutContext={getShortcutContext}
        layoutControls={panelToggleControls}
        // No composer: the panel offers no comments and no "Add to chat".
        composerDraftTarget={null}
        configuredPreviewUrls={NO_PROJECT_SCRIPTS}
        workspaceMutationId={workspace.mutationId}
        // No composer: previews and terminals offer no "send to chat".
        onSendAnnotation={undefined}
        terminal={{
          launchContext: null,
          keybindings,
          onAddTerminalContext: undefined,
          splitShortcutLabel: terminalShortcutLabel("terminal.split"),
          splitVerticalShortcutLabel: terminalShortcutLabel("terminal.splitVertical"),
          newShortcutLabel: terminalShortcutLabel("terminal.new"),
          closeShortcutLabel: terminalShortcutLabel("terminal.close"),
        }}
        files={{
          projectName: project.title,
          workspaceRoot: thread.worktreePath ?? project.workspaceRoot,
          availableEditors,
        }}
      />
      <LinkPullRequestDialogHost />
      <ThreadVisitWatermark threadRef={threadRef} />
    </div>
  );
}

/**
 * The last error of the thread, such as a message that the shell could not run. ChatView floats it
 * over the timeline; here it sits above the shell, so it never covers the output.
 */
function TerminalThreadError(props: {
  readonly threadRef: ScopedThreadRef;
  readonly thread: EnvironmentThreadShell;
}) {
  const runtime = props.thread.runtime;
  const threadKey = scopedThreadKey(props.threadRef);
  const error = runtime?.lastError ?? null;
  const bannerKey = getThreadErrorBannerKey(threadKey, error);
  // State, not only the session set, so a dismiss re-renders a compiled caller.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const dismissed = bannerKey === dismissedKey || isThreadErrorBannerDismissedForSession(bannerKey);
  return (
    <ThreadErrorBanner
      error={shouldShowThreadErrorBanner(threadKey, error, dismissed) ? error : null}
      errorClass={runtime?.lastErrorClass ?? null}
      onDismiss={() => {
        dismissThreadErrorBannerForSession(bannerKey);
        setDismissedKey(bannerKey);
      }}
    />
  );
}

/**
 * The snooze and settle line and the environment notices of ChatView, below the shell where
 * ChatView shows them above the composer. A bell or an ended program wakes a snoozed thread early.
 */
function TerminalThreadNotices(props: {
  readonly threadRef: ScopedThreadRef;
  readonly thread: EnvironmentThreadShell;
}) {
  const { threadRef, thread } = props;
  const capabilities = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId))
    ?.environment.capabilities;
  const statusLine = useForkThreadStatusLine({
    threadRef,
    thread,
    latestRunCompletedAt: thread.latestRun?.completedAt ?? null,
    supportsSnooze: capabilities?.threadSnooze === true,
    supportsSettlement: capabilities?.threadSettlement === true,
    canOperate: useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
  });
  const environment = useEnvironment(threadRef.environmentId);
  const { environments } = useEnvironments();
  const environmentUnavailable =
    environment !== null && environment.connection.phase !== "connected";
  const bannerItems = useSystemComposerBanners({
    activeEnvironment: environment,
    activeEnvironmentUnavailable: environmentUnavailable,
    activeEnvironmentUnavailableState:
      environment !== null && environmentUnavailable
        ? {
            environmentId: environment.environmentId,
            label: environment.label,
            connection: environment.connection,
          }
        : null,
    activeThreadEnvironmentId: threadRef.environmentId,
    serverConfig: environment?.serverConfig ?? null,
    hasMultipleRegisteredEnvironments: environments.length > 1,
    automaticEnvironment: false,
    autoUpdateEnvironments: NO_ENVIRONMENTS,
  });
  if (statusLine.line === null && bannerItems.length === 0) return null;
  return (
    // The banners take their width from the composer inset, which this screen has no composer to
    // set. Without it they shrink to their icon.
    <div className="flex flex-col gap-1 px-3 pb-2 [--chat-composer-drawer-inset:0px] [--chat-content-max-width:100%]">
      {statusLine.line}
      <ComposerBannerStack items={bannerItems} />
    </div>
  );
}

/**
 * The git checkout, linked pull request and terminal labels that the panels of a terminal thread
 * read. ChatView derives the same from its own state.
 */
function useTerminalThreadWorkspace(
  threadRef: ScopedThreadRef,
  thread: EnvironmentThreadShell | null,
  project: EnvironmentProject | null,
) {
  const environmentId: EnvironmentId = threadRef.environmentId;
  const gitCwd = project
    ? projectScriptCwd({
        project: { cwd: project.workspaceRoot },
        worktreePath: thread?.worktreePath ?? null,
      })
    : null;
  const sessions = useKnownTerminalSessions({
    environmentId,
    threadId: threadRef.threadId,
  });
  // The shell has no turns. A command that ends in the main terminal can change the checkout,
  // so its end refreshes git status and the open diff and file panels.
  const mainSummary = sessions?.find((session) => session.target.terminalId === DEFAULT_TERMINAL_ID)
    ?.state.summary;
  const mutationId =
    mainSummary && !mainSummary.hasRunningSubprocess ? mainSummary.updatedAt : null;
  const gitStatusQuery = useEnvironmentQuery(
    gitCwd === null ? null : vcsEnvironment.status({ environmentId, input: { cwd: gitCwd } }),
  );
  useWorkspaceMutationRefresh({
    enabled: gitCwd !== null,
    mutationId,
    refresh: gitStatusQuery.refresh,
    resourceKey: `git-status:${threadRef.threadId}:${gitCwd ?? ""}`,
  });
  const liveIsGitRepo = gitStatusQuery.data?.isRepo;
  useEffect(() => {
    if (gitCwd !== null && liveIsGitRepo !== undefined) {
      rememberCheckoutIsRepo(environmentId, gitCwd, liveIsGitRepo);
    }
  }, [environmentId, gitCwd, liveIsGitRepo]);
  const isGitRepo = liveIsGitRepo ?? recallCheckoutIsRepo(environmentId, gitCwd) ?? true;
  const { linked: linkedPullRequest } = useThreadLinkedPullRequest({
    serverThreadRef: threadRef,
    environmentId,
    persisted: thread?.linkedPullRequest ?? null,
    projectId: project?.id ?? null,
    projectRepository: sourceControlClients.repositorySelector(project?.repositoryIdentity),
    threadBranch: thread?.branch ?? null,
    gitStatus: gitStatusQuery.data ?? null,
  });
  const terminalLabelsById = new Map(
    (sessions ?? []).map((session) => [
      session.target.terminalId,
      resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
    ]),
  );
  const environments = useLogicalProjectEnvironments(project, false);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const remoteOpenState = useRemoteOpenState(environmentId);
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName: project?.title,
    activeThreadEnvironmentId: environmentId,
    primaryEnvironmentId,
    remoteOpenMode: remoteOpenState.mode,
  });
  return {
    gitCwd,
    isGitRepo,
    mutationId,
    linkedPullRequest,
    terminalLabelsById,
    environments,
    showOpenInPicker,
  };
}

/** The thread shortcuts of ChatView that apply to a terminal thread. */
function useThreadShortcuts(threadRef: ScopedThreadRef, linkedPullRequestUrl: string | null) {
  const thread = useQuietThreadShell(threadRef);
  const openPanelPullRequestUrl = useOpenPanelPullRequestUrl(threadRef);
  const capabilities = useAtomValue(serverEnvironment.configValueAtom(threadRef.environmentId))
    ?.environment.capabilities;
  const { settleThread, unsettleThread, pinThread, confirmAndUnpinThread } = useThreadActions();
  const canOperate = () =>
    readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);

  const copyReference = () => {
    if (!thread) return;
    const target = resolveThreadReferenceCopyTarget({
      threadId: thread.id,
      openPanelPullRequestUrl,
      pullRequests: thread.pullRequests,
      linkedPullRequestUrl: linkedPullRequestUrl ?? thread.branchPullRequest?.url ?? null,
    });
    if (target === null) return;
    void writeTextToClipboard(target.value, target.clipboardTarget).then(
      (didCopy) => {
        if (didCopy)
          toastManager.add({
            type: "success",
            title: target.successTitle,
            description: target.value,
          });
      },
      (error: unknown) => toastFailure(target.failureTitle, error),
    );
  };

  const toggleSettled = () => {
    if (!canOperate()) return false;
    if (!thread || capabilities?.threadSettlement !== true) return;
    if (thread.settledOverride === "settled") {
      void unsettleThread(threadRef).then(toastResultFailure("Failed to un-settle thread"));
      return;
    }
    if (settleAndAdvance(threadRef)) return;
    void settleThread(threadRef).then(toastResultFailure("Failed to settle thread"));
  };

  const togglePinned = () => {
    if (!canOperate()) return false;
    if (!thread || capabilities?.threadPinning !== true) return;
    const pinned = thread.pinnedAt != null;
    void (pinned ? confirmAndUnpinThread(threadRef) : pinThread(threadRef)).then(
      toastResultFailure(pinned ? "Failed to unpin thread" : "Failed to pin thread"),
    );
  };

  return { copyReference, toggleSettled, togglePinned };
}

function toastFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

const toastResultFailure = (title: string) => (result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastFailure(title, squashAtomCommandFailure(result));
};

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
  // A terminal in the right panel is not a drawer terminal either, like in the chat drawer
  // (`panelTerminalIds` of PersistentThreadTerminals.tsx). Otherwise the drawer reuses it, and one
  // shell shows in both places.
  const panelSurfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
  const panelTerminalIds = new Set(
    panelSurfaces.flatMap((surface) => (surface.kind === "terminal" ? surface.terminalIds : [])),
  );
  const drawerSessions = (sessions ?? []).filter(
    (session) =>
      session.target.terminalId !== DEFAULT_TERMINAL_ID &&
      !panelTerminalIds.has(session.target.terminalId),
  );
  // The drawer never holds the thread's own shell. An older client state can list it; that entry
  // goes, and the shell keeps running.
  const drawerListsMainTerminal = uiState.terminalIds.includes(DEFAULT_TERMINAL_ID);
  useEffect(() => {
    if (drawerListsMainTerminal) store().closeTerminal(threadRef, DEFAULT_TERMINAL_ID);
  }, [drawerListsMainTerminal, store, threadRef]);

  const launch = (place: "new" | "split" | "splitVertical") => {
    if (!canOperate) return false;
    const activeGroup = uiState.terminalGroups.find((group) =>
      group.terminalIds.includes(uiState.activeTerminalId),
    );
    if (place !== "new" && (activeGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP)
      return;
    // An empty drawer that opens seeds `term-1`, the shell of this thread. Its first terminal
    // gets its own id instead.
    if (uiState.terminalIds.length === 0) {
      void terminalActions.launchTerminal({
        place: (terminalId) =>
          store().ensureTerminal(threadRef, terminalId, { open: true, active: true }),
      })?.result;
      focusActiveDrawerTerminal(threadRef);
      return;
    }
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
    focusTerminal(threadRef, launched.terminalId);
    void launched.result;
  };

  const focusMain = () => focusTerminal(threadRef, DEFAULT_TERMINAL_ID);

  const toggle = () => {
    if (uiState.terminalOpen) {
      store().setTerminalOpen(threadRef, false);
      // Closing the drawer gives focus back to the main terminal.
      focusMain();
      return;
    }
    if (!canRead && !canOperate) return false;
    if (uiState.terminalIds.length > 0 || !canOperate) {
      store().setTerminalOpen(threadRef, true);
      focusActiveDrawerTerminal(threadRef);
      return;
    }
    // Sessions that another client started exist before this drawer knows them. Reuse one.
    const existing = drawerSessions[0]?.target.terminalId;
    if (existing !== undefined) {
      store().ensureTerminal(threadRef, existing, { open: true, active: true });
      focusActiveDrawerTerminal(threadRef);
      return;
    }
    void terminalActions.launchTerminal({
      place: (terminalId) => store().ensureTerminal(threadRef, terminalId, { open: true }),
    })?.result;
    focusActiveDrawerTerminal(threadRef);
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
        focusActiveDrawerTerminal(threadRef);
      },
    );
  };

  return {
    available: canRead || canOperate,
    open: uiState.terminalOpen,
    focusMain,
    toggle,
    launch,
    requestCloseActive,
  };
}

/** `term-1` of the thread, and the visit that clears the attention that the user sees. */
function MainTerminal(props: {
  readonly threadRef: ScopedThreadRef;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly shell: string | undefined;
  readonly keybindings: ResolvedKeybindingsConfig;
  /** The server setting is off: the saved output shows, and no shell starts. */
  readonly readOnly: boolean;
}) {
  const { threadRef } = props;

  // Attention that the user sees counts as a visit on the server, so every client clears it. Like
  // the chat watermark, a visible page counts without focus (a second screen, a preview tab); a
  // hidden tab marks it when it shows again. The visit uses the server time of the
  // attention, because a client clock can be behind it.
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const summary = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  })?.find((known) => known.target.terminalId === DEFAULT_TERMINAL_ID)?.state.summary;
  // A failed start counts like attention. It is the last update of the session, so it is later.
  const seenAt = (summary ? terminalThreadState(summary).failedAt : null) ?? summary?.attention?.at;

  // A thread that started without a command (the enlarge button) is named after its first one.
  const commandTitle = terminalThreadCommandTitle({
    title: props.title,
    command: summary?.command,
    shell: props.shell,
  });
  const canRename = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  useEffect(() => {
    if (commandTitle === null || !canRename) return;
    void updateMetadata({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, title: commandTitle },
    });
  }, [canRename, commandTitle, threadRef, updateMetadata]);
  useEffect(() => {
    if (seenAt === undefined) return;
    const markSeen = () => {
      if (document.visibilityState !== "visible") return;
      void visitThread({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, visitedAt: seenAt },
      });
    };
    markSeen();
    document.addEventListener("visibilitychange", markSeen);
    return () => document.removeEventListener("visibilitychange", markSeen);
  }, [seenAt, threadRef, visitThread]);

  return (
    <ForkShellTerminal
      threadRef={threadRef}
      workspaceRoot={props.workspaceRoot}
      worktreePath={props.worktreePath}
      shell={props.shell}
      keybindings={props.keybindings}
      className="p-2"
      {...(props.readOnly
        ? {
            readOnlyNotice: (
              <span>
                Terminal threads are off, so this thread shows its saved output only. Turn them on
                in{" "}
                <Link to="/settings/terminal" className="underline underline-offset-2">
                  {TERMINAL_THREADS_SETTING_PATH}
                </Link>
                .
              </span>
            ),
          }
        : {})}
    />
  );
}

/** The header link to the parent of a subagent thread, as ChatView builds it. */
function useParentThreadLink(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "lineage"> | null | undefined,
): { threadId: ThreadId; title: string } | null {
  const parentSubagentThreadId =
    thread?.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null;
  const parentSubagentThreadRef =
    thread && parentSubagentThreadId !== null
      ? scopeThreadRef(thread.environmentId, parentSubagentThreadId)
      : null;
  const parentSubagentThread = useQuietThreadShell(parentSubagentThreadRef);
  return parentSubagentThreadRef === null
    ? null
    : {
        threadId: parentSubagentThreadRef.threadId,
        title: parentSubagentThread?.title ?? "Parent thread",
      };
}
