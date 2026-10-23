import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  type PreviewAnnotationPayload,
  type ProjectId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ServerConfig,
  type ThreadLinkedPullRequest,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";

import { BrowserSettingsReadError } from "../../browser/openFileInPreview";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import type { ComposerImageAttachment, DraftId } from "../../composerDraftStore";
import { useDiffPanelStore } from "../../diffPanelStore";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePreviewPanelInlineSize } from "../../hooks/usePreviewPanelInlineSize";
import { useRightPanelSurfaceClose } from "../../hooks/useRightPanelSurfaceClose";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { ShortcutMatchContext } from "../../keybindings";
import { confirmTerminalClose } from "../../lib/terminalCloseConfirm";
import { cn } from "../../lib/utils";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";
import {
  browserMiniPlayerSource,
  previewMiniPlayerSourceKey,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "../../previewMiniPlayerStore";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  useThreadPreviewState,
} from "../../previewStateStore";
import {
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
  type ThreadPanelPresentation,
} from "../../rightPanelLayout";
import {
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadPanelOpen,
  selectThreadRightPanelState,
  type RightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { useDeviceState } from "../../state/device";
import { useEnvironmentSupportsServerBrowser } from "../../state/entities";
import { previewEnvironment } from "../../state/preview";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { MAX_TERMINALS_PER_GROUP } from "../../types";
import { shouldRenderPreviewMiniPlayer } from "../ChatView.logic";
import { addBrowserSurface } from "../preview/addBrowserSurface";
import { subscribePreviewAction } from "../preview/previewActionBus";
import { ThreadPreviewMiniPlayer } from "../preview/ThreadPreviewMiniPlayer";
import { useAgentOpenedPreviews } from "../preview/useAgentOpenedPreviews";
import { usePreviewSession } from "../preview/usePreviewSession";
import { threadPullRequestPanelTarget } from "../pullRequest/pullRequestDetail.logic";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelTabs } from "../RightPanelTabs";
import { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { DeviceSetupDialogHost, openDeviceSetupDialog } from "./ChatOverlayHosts";
import {
  PanelLayoutControls,
  type PanelLayoutControlsProps,
  RightPanelMaximizeControl,
} from "./PanelLayoutControls";
import {
  type RightPanelFileProps,
  RightPanelSurfaceContent,
  type RightPanelTerminalProps,
} from "./RightPanelSurfaceContent";

const EMPTY_PENDING_FILE_SURFACE_IDS: ReadonlySet<string> = new Set();

export type ThreadRightPanel = ReturnType<typeof useThreadRightPanel>;

/**
 * The right panel and the thread panel of a thread: their state and the actions that change
 * them. ChatView and the screen of a terminal thread (`ForkTerminalThreadScreen`) share it, and
 * render it with `ThreadRightPanelView` and `ThreadRightPanelHosts`.
 */
export function useThreadRightPanel(input: {
  readonly threadRef: ScopedThreadRef | null;
  /** A maximize request names the route's thread, before the thread loads. */
  readonly routeThreadRef: ScopedThreadRef;
  readonly project: EnvironmentProject | null;
  readonly projectId: ProjectId | null;
  readonly isServerThread: boolean;
  readonly isGitRepo: boolean;
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly linkedPullRequest: ThreadLinkedPullRequest | null;
  readonly branchPullRequest: ThreadLinkedPullRequest | null | undefined;
  /** The element that holds the chat column and the inline panel; it sizes the panel. */
  readonly container: HTMLElement | null;
  readonly terminalLabelsById: ReadonlyMap<string, string>;
  readonly requestTerminalFocus: () => void;
  readonly onDiffPanelOpen: (() => void) | undefined;
}) {
  const {
    threadRef: activeThreadRef,
    routeThreadRef,
    project: activeProject,
    isServerThread,
    isGitRepo,
    serverConfig,
    linkedPullRequest: linkedThreadPullRequest,
    terminalLabelsById: activeTerminalLabelsById,
    requestTerminalFocus,
    onDiffPanelOpen,
  } = input;
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const terminalActions = useThreadTerminalActions(activeThreadRef);
  const canOperateTerminal = useEnvironmentScope(
    activeThreadRef?.environmentId ?? null,
    AuthTerminalOperateScope,
  );
  const hasTerminalWriteAccess = () =>
    activeThreadRef !== null &&
    readEnvironmentScope(activeThreadRef.environmentId, AuthTerminalOperateScope);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const shouldUsePlanSidebarSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const activeEnvironmentServerBrowser = useEnvironmentSupportsServerBrowser(
    activeThreadRef?.environmentId ?? null,
  );
  const browserAvailable = isPreviewSupportedInRuntime() || activeEnvironmentServerBrowser;
  const previewPanelInlineSize = usePreviewPanelInlineSize(undefined, {
    container: input.container,
    widthStorageKey: `t3code:preview-panel-width:${activeThreadKey}`,
  });
  const activeRightPanelKind = useRightPanelStore((state) =>
    selectActiveRightPanel(state.byThreadKey, activeThreadRef),
  );
  const rightPanelState = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, activeThreadRef),
  );
  const activeRightPanelSurface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, activeThreadRef),
  );
  const activePreviewState = useThreadPreviewState(activeThreadRef);
  const activePreviewServerEpoch = activePreviewState.serverEpoch;
  const previewSessionsReady = !activeEnvironmentServerBrowser || activePreviewState.listLoaded;
  const resolvePreviewRuntimeTabId = activeThreadRef
    ? (tabId: string) => previewRuntimeTabId(activeThreadRef, activePreviewServerEpoch, tabId)
    : undefined;
  const activePreviewMiniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, activeThreadRef),
  );
  const previewPanelOpen = activeRightPanelKind === "preview" && browserAvailable;
  const rightPanelOpen = rightPanelState.isOpen;
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const rightPanelPresenceValue = {
    activeSurface: activeRightPanelSurface,
    surfaces: rightPanelState.surfaces,
  };
  const rightPanelPresence = usePanelPresence(
    rightPanelOpen && activeThreadRef !== null,
    rightPanelPresenceValue,
    panelAnimationsActive,
    activeThreadKey,
    panelAnimationDurationMs,
  );
  const rightPanelPresent = rightPanelPresence.present;
  const rightPanelControlsInPanel =
    shouldUsePlanSidebarSheet && rightPanelPresent && rightPanelOpen;
  const rightPanelControlsAtRoot = rightPanelPresent && !shouldUsePlanSidebarSheet;
  const renderedRightPanelSurface = rightPanelPresence.value?.activeSurface ?? null;
  const renderedRightPanelSurfaces = rightPanelPresence.value?.surfaces ?? [];
  const previewMiniPlayerVisible = shouldRenderPreviewMiniPlayer(
    activePreviewMiniPlayer?.source ?? null,
    renderedRightPanelSurface,
  );
  const canMaximizeRightPanel = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const rightPanelMaximized = canMaximizeRightPanel && rightPanelState.maximized === true;
  const inlineRightPanelOwnsTitleBar = rightPanelOpen && !shouldUsePlanSidebarSheet;
  const [threadPanelPresentation, setThreadPanelPresentation] =
    useState<ThreadPanelPresentation>("inline");
  const threadPanelOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(
      state.threadPanelVisibilityByThreadKey,
      activeThreadRef,
      threadPanelPresentation,
    ),
  );

  useEffect(() => {
    if (!activeThreadRef || !previewSessionsReady) return;
    const hiddenTabIds = new Set(
      Object.values(activePreviewState.sessions)
        .filter((session) => session.runtime === "server" && session.reveal === false)
        .map((session) => session.tabId),
    );
    useRightPanelStore
      .getState()
      .reconcileBrowserSurfaces(
        activeThreadRef,
        Object.keys(activePreviewState.sessions),
        hiddenTabIds,
      );
  }, [activePreviewState.sessions, activeThreadRef, previewSessionsReady]);

  useEffect(() => {
    const source = activePreviewMiniPlayer?.source;
    if (
      activeThreadRef &&
      previewSessionsReady &&
      source?.kind === "browser" &&
      !activePreviewState.sessions[source.tabId]
    ) {
      usePreviewMiniPlayerStore.getState().close(activeThreadRef);
    }
  }, [activePreviewMiniPlayer, activePreviewState.sessions, activeThreadRef, previewSessionsReady]);

  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null;
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  const handleFilePendingChange = (relativePath: string, pending: boolean) => {
    if (!activeProjectKey) return;
    setPendingFileSurfaceIdsByProject((currentByProject) => {
      const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
      const surfaceId = `file:${relativePath}`;
      if (current.has(surfaceId) === pending) return currentByProject;
      const next = new Set(current);
      if (pending) next.add(surfaceId);
      else next.delete(surfaceId);
      const nextByProject = new Map(currentByProject);
      if (next.size === 0) nextByProject.delete(activeProjectKey);
      else nextByProject.set(activeProjectKey, next);
      return nextByProject;
    });
  };
  const handleFilePendingChangeStable = useStableCallback(handleFilePendingChange);

  const canOperatePreview = useEnvironmentScope(
    activeThreadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  const createBrowserSurface = (profileId?: string) => {
    if (!activeThreadRef || !canOperatePreview) return;
    void addBrowserSurface({
      threadRef: activeThreadRef,
      openPreview,
      ...(profileId === undefined ? {} : { profileId }),
    }).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      if (error instanceof BrowserSettingsReadError) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open browser",
            description: error.message,
          }),
        );
      }
    });
  };
  const createBrowserSurfaceStable = useStableCallback(createBrowserSurface);
  const addDiffSurface = () => {
    if (!activeThreadRef || !isServerThread || !isGitRepo) return;
    useDiffPanelStore.getState().selectGitScope(activeThreadRef, "branch");
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  };
  const addDiffSurfaceStable = useStableCallback(addDiffSurface);
  const openChangesFromThreadPanel = () => {
    addDiffSurface();
  };
  const openChangesFromThreadPanelStable = useStableCallback(openChangesFromThreadPanel);
  const addFilesSurface = () => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().open(activeThreadRef, "files");
  };
  const addFilesSurfaceStable = useStableCallback(addFilesSurface);
  const pullRequestsCapabilityKnown = serverConfig !== null;
  const supportsPullRequests = serverConfig?.environment.capabilities.pullRequests === true;
  const supportsThreadPullRequests =
    serverConfig?.environment.capabilities.threadPullRequests === true;
  const visiblePullRequests = visibleThreadPullRequests(input.pullRequests);
  const visiblePullRequestCount = visiblePullRequests.length;
  const pullRequestsSurfaceAvailable =
    isServerThread && supportsThreadPullRequests && visiblePullRequestCount > 0;
  const addPullRequestsSurface = () => {
    if (!activeThreadRef || !pullRequestsSurfaceAvailable) return;
    useRightPanelStore.getState().open(activeThreadRef, "pull-requests");
  };
  const addPullRequestsSurfaceStable = useStableCallback(addPullRequestsSurface);
  const pullRequestPanelTarget =
    input.projectId !== null
      ? threadPullRequestPanelTarget({
          projectId: input.projectId,
          pullRequests: visiblePullRequests,
          linkedPullRequest: linkedThreadPullRequest,
          branchPullRequest: input.branchPullRequest,
        })
      : null;
  const addPullRequestSurface = () => {
    if (!supportsPullRequests || activeThreadRef === null || pullRequestPanelTarget === null)
      return;
    useRightPanelStore.getState().openPullRequest(activeThreadRef, pullRequestPanelTarget);
  };
  const addPullRequestSurfaceStable = useStableCallback(addPullRequestSurface);
  const pullRequestSurfaceAvailable = supportsPullRequests && pullRequestPanelTarget !== null;
  const addMachinesSurface = () => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "machines");
  };
  const addMachinesSurfaceStable = useStableCallback(addMachinesSurface);
  const { state: deviceState, loaded: deviceStateLoaded } = useDeviceState(
    activeThreadRef?.environmentId ?? null,
  );
  const addDeviceSurface = () => {
    if (!activeThreadRef) return;
    if (!deviceState.onboardingCompleted || deviceState.hostStatus === "disabled") {
      openDeviceSetupDialog(scopedThreadKey(activeThreadRef));
      return;
    }
    useRightPanelStore.getState().open(activeThreadRef, "device");
  };
  const addDeviceSurfaceStable = useStableCallback(addDeviceSurface);
  useAgentOpenedPreviews({
    threadRef: activeThreadRef,
    deviceState,
    deviceStateLoaded,
    previewState: activePreviewState,
    serverBrowserAvailable: activeEnvironmentServerBrowser,
    panelSurfaces: rightPanelState.surfaces,
    miniPlayerSource: activePreviewMiniPlayer?.source ?? null,
    sheetLayout: shouldUsePlanSidebarSheet,
  });
  const openFileSurface = (relativePath: string) => {
    if (!activeThreadRef || !activeProject) return;
    useRightPanelStore.getState().openFile(activeThreadRef, relativePath);
  };
  const openFileSurfaceStable = useStableCallback(openFileSurface);
  const closePreviewPanel = () => {
    if (activeThreadRef) {
      if (activeRightPanelSurface?.kind === "preview" && activeRightPanelSurface.resourceId) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadRef, browserMiniPlayerSource(activeRightPanelSurface.resourceId));
      } else if (activeRightPanelSurface?.kind === "device" && activeRightPanelSurface.target) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadRef, { kind: "device", ...activeRightPanelSurface.target });
      }
      useRightPanelStore.getState().setMaximized(activeThreadRef, false);
      useRightPanelStore.getState().close(activeThreadRef);
    }
  };
  const closePreviewPanelStable = useStableCallback(closePreviewPanel);
  const togglePreviewPanel = () => {
    if (!activeThreadRef || !browserAvailable) return;
    if (previewPanelOpen) {
      closePreviewPanel();
      return;
    }
    if (!canOperatePreview) return;
    const activeTabId = activePreviewState.activeTabId;
    if (activeTabId) {
      useRightPanelStore.getState().openBrowser(activeThreadRef, activeTabId);
    } else {
      createBrowserSurface();
    }
  };
  const togglePreviewPanelStable = useStableCallback(togglePreviewPanel);
  const addTerminalSurface = () => {
    if (!activeThreadRef) return;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) =>
        useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId),
    });
    if (!launched) return;
    requestTerminalFocus();
    void launched.result;
  };
  const addTerminalSurfaceStable = useStableCallback(addTerminalSurface);
  const splitPanelTerminal = (direction: "horizontal" | "vertical" = "horizontal") => {
    if (
      !activeThreadRef ||
      activeRightPanelSurface?.kind !== "terminal" ||
      activeRightPanelSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
    ) {
      return;
    }
    const surfaceId = activeRightPanelSurface.id;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) =>
        useRightPanelStore
          .getState()
          .splitTerminal(activeThreadRef, surfaceId, terminalId, direction),
    });
    if (!launched) return;
    requestTerminalFocus();
    void launched.result;
  };
  const splitPanelTerminalStable = useStableCallback(splitPanelTerminal);
  const splitPanelTerminalVertical = () => {
    splitPanelTerminal("vertical");
  };
  const splitPanelTerminalVerticalStable = useStableCallback(splitPanelTerminalVertical);
  const activatePanelTerminal = (terminalId: string) => {
    if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
    useRightPanelStore
      .getState()
      .activateTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
    requestTerminalFocus();
  };
  const activatePanelTerminalStable = useStableCallback(activatePanelTerminal);
  const closePanelTerminal = (terminalId: string) => {
    if (
      !hasTerminalWriteAccess() ||
      !activeThreadRef ||
      activeRightPanelSurface?.kind !== "terminal"
    )
      return;
    terminalActions.closeTerminalSession(terminalId);
    useTerminalUiStateStore.getState().closeTerminal(activeThreadRef, terminalId);
    useRightPanelStore
      .getState()
      .closeTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
    requestTerminalFocus();
  };
  const closePanelTerminalStable = useStableCallback(closePanelTerminal);
  const requestClosePanelTerminal = (terminalId: string) => {
    if (!hasTerminalWriteAccess()) return;
    const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
    void confirmTerminalClose([label]).then((confirmed) => {
      if (confirmed && hasTerminalWriteAccess()) {
        closePanelTerminal(terminalId);
      }
    });
  };
  const requestClosePanelTerminalStable = useStableCallback(requestClosePanelTerminal);
  const activateRightPanelSurface = (surface: RightPanelSurface) => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
    if (surface.kind === "preview" && surface.resourceId) {
      setActivePreviewTab(activeThreadRef, surface.resourceId);
    }
    if (surface.kind === "terminal") {
      requestTerminalFocus();
    }
    if (surface.kind === "diff" && activeRightPanelKind !== "diff") {
      onDiffPanelOpen?.();
    }
  };
  const activateRightPanelSurfaceStable = useStableCallback(activateRightPanelSurface);
  const toggleRightPanel = () => {
    if (!activeThreadRef) return;
    if (rightPanelOpen) {
      closePreviewPanel();
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
  };
  const toggleRightPanelStable = useStableCallback(toggleRightPanel);
  const toggleThreadPanel = () => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().toggleThreadPanel(activeThreadRef, threadPanelPresentation);
  };
  const toggleThreadPanelStable = useStableCallback(toggleThreadPanel);
  useEffect(() => {
    if (!canMaximizeRightPanel) return;
    if (useRightPanelStore.getState().consumeMaximizeRequest(routeThreadRef)) {
      useRightPanelStore.getState().setMaximized(routeThreadRef, true);
    }
  }, [canMaximizeRightPanel, routeThreadRef]);
  const toggleRightPanelMaximized = () => {
    if (!canMaximizeRightPanel || !activeThreadRef) return;
    useRightPanelStore.getState().setMaximized(activeThreadRef, !rightPanelMaximized);
  };
  const toggleRightPanelMaximizedStable = useStableCallback(toggleRightPanelMaximized);
  const {
    closeSurface: closeRightPanelSurface,
    closeOtherSurfaces: closeOtherRightPanelSurfacesStable,
    closeSurfacesToRight: closeRightPanelSurfacesToRightStable,
    closeAllSurfaces: closeAllRightPanelSurfacesStable,
  } = useRightPanelSurfaceClose({
    threadRef: activeThreadRef,
    terminalLabelsById: activeTerminalLabelsById,
  });
  const closeRightPanelSurfaceStable = closeRightPanelSurface;
  const moveRightPanelSurface = (surfaceId: string, toIndex: number) => {
    if (activeThreadRef)
      useRightPanelStore.getState().moveSurface(activeThreadRef, surfaceId, toIndex);
  };
  const moveRightPanelSurfaceStable = useStableCallback(moveRightPanelSurface);
  const copyRightPanelFilePath = (relativePath: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(relativePath).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: relativePath,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  };
  const copyRightPanelFilePathStable = useStableCallback(copyRightPanelFilePath);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") togglePreviewPanelStable();
      }),
    [togglePreviewPanelStable],
  );
  // A focused desktop browser page forwards these chords as menu actions.
  useEffect(() => {
    return window.desktopBridge?.onMenuAction((action) => {
      if (action === "rightPanel.toggle") toggleRightPanelStable();
      else if (action === "rightPanel.toggleMaximized") toggleRightPanelMaximizedStable();
    });
  }, [toggleRightPanelStable, toggleRightPanelMaximizedStable]);

  return {
    threadRef: activeThreadRef,
    threadKey: activeThreadKey,
    project: activeProject,
    projectId: input.projectId,
    isServerThread,
    isGitRepo,
    canOperateTerminal,
    canOperatePreview,
    browserAvailable,
    activeEnvironmentServerBrowser,
    previewPanelInlineSize,
    shouldUsePlanSidebarSheet,
    panelAnimationsActive,
    panelAnimationDurationMs,
    rightPanelState,
    activeRightPanelSurface,
    activePreviewState,
    activePreviewMiniPlayer,
    resolvePreviewRuntimeTabId,
    previewPanelOpen,
    rightPanelOpen,
    rightPanelPresent,
    rightPanelControlsInPanel,
    rightPanelControlsAtRoot,
    renderedRightPanelSurface,
    renderedRightPanelSurfaces,
    previewMiniPlayerVisible,
    rightPanelMaximized,
    inlineRightPanelOwnsTitleBar,
    threadPanelPresentation,
    setThreadPanelPresentation,
    threadPanelOpen,
    pendingFileSurfaceIds,
    handleFilePendingChangeStable,
    deviceState,
    terminalLabelsById: activeTerminalLabelsById,
    pullRequestsCapabilityKnown,
    supportsPullRequests,
    visiblePullRequests,
    visiblePullRequestCount,
    pullRequestsSurfaceAvailable,
    pullRequestSurfaceAvailable,
    linkedPullRequest: linkedThreadPullRequest,
    branchPullRequest: input.branchPullRequest,
    createBrowserSurface,
    createBrowserSurfaceStable,
    addDiffSurfaceStable,
    openChangesFromThreadPanelStable,
    addFilesSurfaceStable,
    addPullRequestsSurfaceStable,
    addPullRequestSurfaceStable,
    addMachinesSurfaceStable,
    addDeviceSurfaceStable,
    openFileSurfaceStable,
    closePreviewPanelStable,
    togglePreviewPanelStable,
    addTerminalSurfaceStable,
    splitPanelTerminalStable,
    splitPanelTerminalVerticalStable,
    activatePanelTerminalStable,
    closePanelTerminalStable,
    requestClosePanelTerminalStable,
    activateRightPanelSurfaceStable,
    toggleRightPanelStable,
    toggleThreadPanelStable,
    toggleRightPanelMaximizedStable,
    closeRightPanelSurface,
    closeRightPanelSurfaceStable,
    closeOtherRightPanelSurfacesStable,
    closeRightPanelSurfacesToRightStable,
    closeAllRightPanelSurfacesStable,
    moveRightPanelSurfaceStable,
    copyRightPanelFilePathStable,
  };
}

/**
 * The right panel of a thread: inline beside the chat column on wide screens, a sheet on narrow
 * ones. A screen without a composer leaves out `onSendAnnotation` and
 * `terminal.onAddTerminalContext`, which hides "send to chat" in previews and terminals.
 */
export function ThreadRightPanelView(props: {
  readonly panel: ThreadRightPanel;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly getShortcutContext: () => ShortcutMatchContext;
  /** The panel toggles, shown in the sheet's tab bar. */
  readonly layoutControls: ReactNode;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly configuredPreviewUrls: ReadonlyArray<string>;
  readonly workspaceMutationId: string | null;
  readonly onSendAnnotation:
    | ((annotation: PreviewAnnotationPayload, image: ComposerImageAttachment | null) => void)
    | undefined;
  readonly terminal: Omit<
    RightPanelTerminalProps,
    | "onSplitTerminal"
    | "onSplitTerminalVertical"
    | "onNewTerminal"
    | "onActiveTerminalChange"
    | "onCloseTerminal"
  >;
  readonly files: Pick<RightPanelFileProps, "projectName" | "workspaceRoot" | "availableEditors">;
}) {
  const { panel, keybindings, getShortcutContext } = props;
  const threadRef = panel.threadRef;
  if (!panel.rightPanelPresent || threadRef === null) return null;
  const content = (
    <RightPanelSurfaceContent
      surface={panel.renderedRightPanelSurface}
      activeSurfaceId={panel.activeRightPanelSurface?.id ?? null}
      threadRef={threadRef}
      environmentId={threadRef.environmentId}
      visible={panel.rightPanelOpen}
      composerDraftTarget={props.composerDraftTarget}
      keybindings={keybindings}
      configuredPreviewUrls={props.configuredPreviewUrls}
      workspaceMutationId={props.workspaceMutationId}
      getShortcutContext={getShortcutContext}
      onSendAnnotation={props.onSendAnnotation}
      onCloseSurface={panel.closeRightPanelSurface}
      terminal={{
        ...props.terminal,
        onSplitTerminal: panel.splitPanelTerminalStable,
        onSplitTerminalVertical: panel.splitPanelTerminalVerticalStable,
        onNewTerminal: panel.addTerminalSurfaceStable,
        onActiveTerminalChange: panel.activatePanelTerminalStable,
        onCloseTerminal: panel.closePanelTerminalStable,
      }}
      pullRequest={{
        capabilityKnown: panel.pullRequestsCapabilityKnown,
        supported: panel.supportsPullRequests,
        projectId: panel.projectId,
        pullRequests: panel.visiblePullRequests,
        linkedPullRequest: panel.linkedPullRequest,
        branchPullRequest: panel.branchPullRequest,
        onBack:
          panel.pullRequestsSurfaceAvailable && panel.visiblePullRequestCount > 1
            ? panel.addPullRequestsSurfaceStable
            : undefined,
      }}
      files={{
        ...props.files,
        pendingSurfaceIds: panel.pendingFileSurfaceIds,
        onOpenFile: panel.openFileSurfaceStable,
        onPendingChange: panel.handleFilePendingChangeStable,
      }}
    />
  );
  const tabsProps = {
    open: panel.rightPanelOpen,
    keybindings,
    getShortcutContext,
    inlineSize: panel.previewPanelInlineSize,
    surfaces: panel.renderedRightPanelSurfaces,
    environmentId: threadRef.environmentId,
    activeSurfaceId: panel.renderedRightPanelSurface?.id ?? null,
    pendingSurfaceIds: panel.pendingFileSurfaceIds,
    previewSessions: panel.activePreviewState.sessions,
    desktopByTabId: panel.activePreviewState.desktopByTabId,
    previewRuntimeTabId: panel.resolvePreviewRuntimeTabId,
    terminalLabelsById: panel.terminalLabelsById,
    onActivate: panel.activateRightPanelSurfaceStable,
    onCloseSurface: panel.closeRightPanelSurfaceStable,
    onRenameDevice: (surfaceId: string, title: string) => {
      useRightPanelStore.getState().renameDevice(threadRef, surfaceId, title);
    },
    onCloseOtherSurfaces: panel.closeOtherRightPanelSurfacesStable,
    onCloseSurfacesToRight: panel.closeRightPanelSurfacesToRightStable,
    onCloseAllSurfaces: panel.closeAllRightPanelSurfacesStable,
    onMoveSurface: panel.moveRightPanelSurfaceStable,
    onCopyFilePath: panel.copyRightPanelFilePathStable,
    onAddBrowser: () => panel.createBrowserSurface(),
    onAddBrowserInProfile: panel.createBrowserSurfaceStable,
    onAddTerminal: panel.addTerminalSurfaceStable,
    onAddDiff: panel.addDiffSurfaceStable,
    onAddFiles: panel.addFilesSurfaceStable,
    onAddPullRequest: panel.addPullRequestSurfaceStable,
    onAddPullRequests: panel.addPullRequestsSurfaceStable,
    onAddMachines: panel.addMachinesSurfaceStable,
    machinesAvailable: true,
    onAddDevice: panel.addDeviceSurfaceStable,
    browserAvailable: panel.canOperatePreview && panel.browserAvailable,
    terminalAvailable: panel.project !== null && panel.canOperateTerminal,
    diffAvailable: panel.isServerThread && panel.isGitRepo,
    filesAvailable: panel.project !== null,
    pullRequestAvailable: panel.pullRequestSurfaceAvailable,
    pullRequestsAvailable: panel.pullRequestsSurfaceAvailable,
    deviceAvailable: true,
  } satisfies Omit<ComponentProps<typeof RightPanelTabs>, "mode" | "children">;
  if (!panel.shouldUsePlanSidebarSheet) {
    return (
      <RightPanelTabs {...tabsProps} mode="inline" maximized={panel.rightPanelMaximized}>
        {content}
      </RightPanelTabs>
    );
  }
  return (
    <RightPanelSheet
      animationDurationMs={panel.panelAnimationsActive ? panel.panelAnimationDurationMs : 0}
      open={panel.rightPanelOpen}
      onClose={panel.closePreviewPanelStable}
    >
      <RightPanelTabs
        {...tabsProps}
        mode="sheet"
        layoutControls={
          panel.rightPanelOpen ? (
            <div className="mr-px flex items-center">{props.layoutControls}</div>
          ) : null
        }
      >
        {content}
      </RightPanelTabs>
    </RightPanelSheet>
  );
}

/** The parts of the right panel that stay mounted while it is closed. */
export function ThreadRightPanelHosts(props: { readonly panel: ThreadRightPanel }) {
  const { panel } = props;
  const threadRef = panel.threadRef;
  const miniPlayer = panel.activePreviewMiniPlayer;
  return (
    <>
      <DeviceSetupDialogHost
        threadKey={panel.threadKey}
        threadRef={threadRef}
        state={panel.deviceState}
      />
      {panel.canOperatePreview && threadRef && panel.activeEnvironmentServerBrowser ? (
        <PreviewSessionSync threadRef={threadRef} />
      ) : null}
      {threadRef &&
      miniPlayer &&
      panel.previewMiniPlayerVisible &&
      (miniPlayer.source.kind === "device" || panel.canOperatePreview) ? (
        <ThreadPreviewMiniPlayer
          key={`${panel.threadKey}:${previewMiniPlayerSourceKey(miniPlayer.source)}`}
          threadRef={threadRef}
          miniPlayer={miniPlayer}
        />
      ) : null}
    </>
  );
}

function PreviewSessionSync(props: { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(props.threadRef);
  return null;
}

/** The maximize control and the panel toggles at the top right of the window. */
export function ThreadPanelLayoutControls(props: {
  readonly panel: ThreadRightPanel;
  readonly toggles: ReactNode;
}) {
  const { panel } = props;
  return (
    <div
      className={cn(
        "pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]",
      )}
      data-workspace-titlebar-controls
    >
      {!panel.shouldUsePlanSidebarSheet ? (
        <span
          aria-hidden={!panel.rightPanelOpen}
          className={cn(
            "flex shrink-0",
            panel.panelAnimationsActive &&
              "motion-safe:transition-opacity motion-safe:duration-(--panel-animation-duration) motion-safe:ease-out",
            panel.rightPanelOpen
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none absolute right-full mr-1 opacity-0",
          )}
          inert={!panel.rightPanelOpen}
        >
          <RightPanelMaximizeControl
            maximized={panel.rightPanelMaximized}
            onToggle={panel.toggleRightPanelMaximizedStable}
          />
        </span>
      ) : null}
      <div className="pointer-events-auto flex h-full items-center">{props.toggles}</div>
    </div>
  );
}

/** The panel toggles for the thread panel, the terminal drawer and the right panel. */
export function threadPanelToggleProps(
  panel: ThreadRightPanel,
  screen: Pick<
    PanelLayoutControlsProps,
    "terminalAvailable" | "terminalOpen" | "onToggleTerminal" | "threadPanelPopoverHandle"
  >,
): PanelLayoutControlsProps {
  return {
    ...screen,
    threadPanelOpen: panel.threadPanelOpen,
    threadPanelPresentation: panel.threadPanelPresentation,
    rightPanelAvailable: panel.project !== null,
    rightPanelOpen: panel.rightPanelOpen,
    onToggleThreadPanel: panel.toggleThreadPanelStable,
    onToggleRightPanel: panel.toggleRightPanelStable,
  };
}

/** The thread panel toggle above the chat column while the inline right panel owns the title bar. */
export function ThreadPanelHeaderControl(props: { readonly toggles: PanelLayoutControlsProps }) {
  return (
    <div
      className="absolute top-[var(--workspace-controls-top)] right-[calc(env(safe-area-inset-right)+0.75rem)] z-50 flex h-[var(--workspace-topbar-height)] items-center [-webkit-app-region:no-drag]"
      data-workspace-titlebar-controls
    >
      <PanelLayoutControls
        {...props.toggles}
        showTerminalControl={false}
        showRightPanelControl={false}
      />
    </div>
  );
}
