import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { WifiOffIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useEnvironmentDisconnectDelay } from "../../hooks/useEnvironmentDisconnectDelay";
import { useStableCallback } from "../../hooks/useStableCallback";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildVersionMismatchDismissalKey,
  dismissServerUpdateFailure,
  dismissVersionMismatch,
  isServerUpdateFailureDismissed,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  serverUpdateGuidance,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "../../versionSkew";
import {
  hasEnvironmentReconnectWarningGraceElapsed,
  scheduleEnvironmentReconnectWarning,
} from "../ChatView.logic";
import { ServerUpdateAction } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { ComposerServerUpdateIcon, ComposerServerUpdateStatus } from "./ComposerServerUpdateStatus";

export type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
};

/**
 * The notices of the environment of a thread: offline or reconnecting, and a server update.
 * Shared by ChatView and the terminal thread screen.
 */
export function useEnvironmentBanners(input: {
  readonly environment: EnvironmentPresentation | null;
  // A draft that picks its environment itself shows the update notice of the balancer instead.
  readonly automaticEnvironment: boolean;
}) {
  const { environment: activeEnvironment, automaticEnvironment } = input;
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
    reportFailure: false,
  });
  const serverConfig = activeEnvironment?.serverConfig ?? null;
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironmentConnectionPhase !== "connected";
  const activeReconnectingEnvironmentId =
    activeEnvironmentConnectionPhase === "connecting" ||
    activeEnvironmentConnectionPhase === "reconnecting"
      ? (activeEnvironment?.environmentId ?? null)
      : null;
  const [reconnectWarningGraceElapsedEnvironmentId, setReconnectWarningGraceElapsedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  // Each reconnect attempt gets its own grace period, including a later one to
  // the same environment.
  const [graceReconnectingEnvironmentId, setGraceReconnectingEnvironmentId] = useState(
    activeReconnectingEnvironmentId,
  );
  if (graceReconnectingEnvironmentId !== activeReconnectingEnvironmentId) {
    setGraceReconnectingEnvironmentId(activeReconnectingEnvironmentId);
    setReconnectWarningGraceElapsedEnvironmentId(null);
  }
  const reconnectWarningGraceElapsed = hasEnvironmentReconnectWarningGraceElapsed(
    activeReconnectingEnvironmentId,
    reconnectWarningGraceElapsedEnvironmentId,
  );
  useEffect(() => {
    if (activeReconnectingEnvironmentId === null) return;
    return scheduleEnvironmentReconnectWarning(() =>
      setReconnectWarningGraceElapsedEnvironmentId(activeReconnectingEnvironmentId),
    );
  }, [activeReconnectingEnvironmentId]);
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState = (() => {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment) {
      return null;
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
    };
  })() as EnvironmentUnavailableState | null;
  const handleReconnectActiveEnvironment = async (environmentId: EnvironmentId) => {
    const result = await retryEnvironment(environmentId);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not reconnect environment",
          description: error instanceof Error ? error.message : "Failed to reconnect.",
        }),
      );
    }
  };
  const handleReconnectActiveEnvironmentStable = useStableCallback(
    handleReconnectActiveEnvironment,
  );
  const disconnectDelayElapsed = useEnvironmentDisconnectDelay(
    activeEnvironmentUnavailable ? activeEnvironment.environmentId : null,
  );
  const canDisconnectActiveEnvironment =
    disconnectDelayElapsed &&
    activeEnvironment !== null &&
    activeEnvironment.entry.target._tag !== "PrimaryConnectionTarget" &&
    !isDesktopLocalConnectionTarget(activeEnvironment.entry.target);
  const [disconnectingEnvironment, setDisconnectingEnvironment] = useState(false);
  const handleDisconnectActiveEnvironment = async (environmentId: EnvironmentId) => {
    setDisconnectingEnvironment(true);
    const result = await setEnvironmentEnabled({ environmentId, enabled: false });
    setDisconnectingEnvironment(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not disconnect server",
            description: error instanceof Error ? error.message : "Failed to disconnect.",
          }),
        );
      }
      return;
    }
    void navigate({ to: "/", replace: true });
  };
  const handleDisconnectActiveEnvironmentStable = useStableCallback(
    handleDisconnectActiveEnvironment,
  );
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const versionMismatchDismissKey =
    versionMismatch && activeEnvironment
      ? buildVersionMismatchDismissalKey(activeEnvironment.environmentId, versionMismatch)
      : null;
  const [dismissedVersionMismatchKey, setDismissedVersionMismatchKey] = useState<string | null>(
    null,
  );
  const versionMismatchDismissed =
    versionMismatchDismissKey === dismissedVersionMismatchKey ||
    isVersionMismatchDismissed(versionMismatchDismissKey);
  const showVersionMismatchBanner =
    versionMismatch !== null && versionMismatchDismissKey !== null && !versionMismatchDismissed;
  const hasMultipleRegisteredEnvironments = environments.length > 1;
  const versionMismatchServerLabel =
    hasMultipleRegisteredEnvironments && activeEnvironment
      ? `${activeEnvironment.label} server`
      : "server";
  const serverUpdateEnvironmentId = activeEnvironment?.environmentId ?? null;
  const versionMismatchSelfUpdate = resolveServerSelfUpdateCapability(serverConfig);
  const versionMismatchInstallation = serverConfig?.environment.capabilities.serverInstallation;
  const versionMismatchDesktopAppUpdate = supportsDesktopAppUpdate(serverConfig);
  const versionMismatchThreadContinuation = supportsServerUpdateThreadContinuation(serverConfig);
  const serverUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(serverUpdateEnvironmentId),
  );
  const [dismissedServerUpdateState, setDismissedServerUpdateState] = useState<
    typeof serverUpdateState | null
  >(null);
  const serverUpdateFailureDismissed =
    serverUpdateState === dismissedServerUpdateState ||
    isServerUpdateFailureDismissed(serverUpdateState);
  const items = (() => {
    const items: ComposerBannerStackItem[] = [];
    const updateRunning = serverUpdateState.status === "running";
    const unavailableConnection = activeEnvironmentUnavailableState?.connection ?? null;
    const disconnectAction =
      canDisconnectActiveEnvironment && activeEnvironmentUnavailableState ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={disconnectingEnvironment}
          title="Hide this server's threads. Switch it on again in Connections."
          onClick={() =>
            void handleDisconnectActiveEnvironmentStable(
              activeEnvironmentUnavailableState.environmentId,
            )
          }
        >
          Disconnect server
        </Button>
      ) : undefined;
    const environmentReconnecting =
      unavailableConnection !== null &&
      (unavailableConnection.phase === "connecting" ||
        unavailableConnection.phase === "reconnecting");
    const suppressUnavailableBanner =
      environmentReconnecting && (updateRunning || !reconnectWarningGraceElapsed);
    if (activeEnvironmentUnavailableState && unavailableConnection && !suppressUnavailableBanner) {
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        variant: unavailableConnection.phase === "error" ? "error" : "warning",
        icon: <WifiOffIcon />,
        title: `${activeEnvironmentUnavailableState.label} is ${environmentReconnecting ? "reconnecting" : "offline"}`,
        actions: (
          <>
            {!environmentReconnecting ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void handleReconnectActiveEnvironmentStable(
                    activeEnvironmentUnavailableState.environmentId,
                  )
                }
              >
                Reconnect
              </Button>
            ) : null}
            {disconnectAction}
          </>
        ),
      });
    }
    if (
      !automaticEnvironment &&
      serverUpdateEnvironmentId &&
      (serverUpdateState.status === "idle"
        ? showVersionMismatchBanner
        : !serverUpdateFailureDismissed)
    ) {
      const updateInProgress = serverUpdateState.status === "running";
      const updateFailed = serverUpdateState.status === "failed";
      items.push({
        id: `server-version:${serverUpdateEnvironmentId}`,
        variant: updateFailed ? "error" : "default",
        priority: updateInProgress ? "urgent" : "notice",
        icon: <ComposerServerUpdateIcon status={serverUpdateState.status} />,
        title:
          updateInProgress || updateFailed ? (
            <ComposerServerUpdateStatus
              state={serverUpdateState}
              serverLabel={versionMismatchServerLabel}
            />
          ) : versionMismatch ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="block max-w-full cursor-help truncate rounded-sm text-left"
                  >
                    Server update available
                  </button>
                }
              />
              <TooltipPopup side="top">
                {versionMismatchServerLabel} {versionMismatch.serverVersion}{" "}
                <span aria-hidden="true">→</span> {versionMismatch.clientVersion}
              </TooltipPopup>
            </Tooltip>
          ) : (
            "Server update available"
          ),
        description:
          !updateInProgress &&
          !updateFailed &&
          versionMismatchSelfUpdate !== null &&
          (versionMismatchSelfUpdate !== "desktop-managed" || !versionMismatchDesktopAppUpdate)
            ? serverUpdateGuidance(versionMismatchSelfUpdate)
            : undefined,
        actions: updateInProgress ? (
          disconnectAction
        ) : !versionMismatch ||
          (versionMismatchSelfUpdate === "desktop-managed" &&
            !versionMismatchDesktopAppUpdate) ? undefined : (
          <ServerUpdateAction
            environmentId={serverUpdateEnvironmentId}
            serverLabel={versionMismatchServerLabel}
            selfUpdate={versionMismatchSelfUpdate}
            installation={versionMismatchInstallation}
            desktopAppUpdate={versionMismatchDesktopAppUpdate}
            threadContinuation={versionMismatchThreadContinuation}
            targetVersion={versionMismatch.clientVersion}
            label={updateFailed ? "Retry" : "Update"}
            variant="ghost"
          />
        ),
        ...(updateInProgress || (!updateFailed && !versionMismatchDismissKey)
          ? {}
          : {
              dismissLabel: "Dismiss update notice",
              onDismiss: () => {
                if (updateFailed) {
                  dismissServerUpdateFailure(serverUpdateState);
                  setDismissedServerUpdateState(serverUpdateState);
                }
                dismissVersionMismatch(versionMismatchDismissKey);
                setDismissedVersionMismatchKey(versionMismatchDismissKey);
              },
            }),
      });
    }
    return items;
  })();

  return { unavailableState: activeEnvironmentUnavailableState, items };
}
