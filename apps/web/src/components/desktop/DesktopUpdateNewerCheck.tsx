import type { DesktopBridge } from "@t3tools/contracts";

import {
  getDesktopUpdateActionError,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

type ReportUpdateError = (title: string, description: string) => void;

const toastUpdateError: ReportUpdateError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

/**
 * Fork update policy: an install takes the newest release. Call right before
 * `bridge.installUpdate()`. When a release is newer than the download, it downloads that one.
 * It returns true when the caller can install, and false after a reported error.
 */
export async function prepareNewestUpdateInstall(
  bridge: DesktopBridge,
  { reportError = toastUpdateError }: { readonly reportError?: ReportUpdateError } = {},
): Promise<boolean> {
  try {
    const { newerVersion } = await bridge.checkBeforeUpdateInstall();
    if (newerVersion === null) return true;
    // The check before the install kept the download in the state. This check switches the
    // state to the newest release, so the download below gets that one.
    const checked = await bridge.checkForUpdate();
    if (resolveDesktopUpdateButtonAction(checked.state) !== "download") return true;
    const download = await bridge.downloadUpdate();
    if (download.completed) return true;
    reportError(
      "Could not download the newer update",
      getDesktopUpdateActionError(download) ?? "The download did not finish.",
    );
    return false;
  } catch (error) {
    reportError(
      "Could not check for a newer update",
      error instanceof Error ? error.message : "An unexpected error occurred.",
    );
    return false;
  }
}
