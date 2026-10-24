import type {
  ForkBrowserCaptureCommand,
  ForkBrowserCaptureReport,
} from "@t3tools/contracts/forkBrowserCapture";

import { FORK_BROWSER_CAPTURE_CHANNEL } from "../ipc/channels.ts";
import type { DesktopBrowserTabDebugger, DesktopBrowserTabKey } from "./DesktopBrowserHost.ts";

const keyOf = (key: DesktopBrowserTabKey) => `${key.threadId}\u0000${key.tabId}`;

// Fork: only the renderer that owns the guest may acknowledge its placement or visibility.
export const makeForkBrowserCapture = (
  emit: (report: ForkBrowserCaptureReport) => void,
  find: (key: DesktopBrowserTabKey) => DesktopBrowserTabDebugger | undefined,
) => {
  const presented = new Map<string, boolean>();
  return {
    report: (report: ForkBrowserCaptureReport, senderId: number | undefined) => {
      const host = find(report)?.webContents.hostWebContents;
      if (!host || host.id !== senderId || host.isDestroyed()) return;
      if (report.type === "presentation") {
        if (presented.get(keyOf(report)) === report.visible) return;
        presented.set(keyOf(report), report.visible);
      }
      emit(report);
    },
    command: (command: ForkBrowserCaptureCommand) => {
      const host = find(command)?.webContents.hostWebContents;
      if (host && !host.isDestroyed()) host.send(FORK_BROWSER_CAPTURE_CHANNEL, command);
    },
    announce: (key: DesktopBrowserTabKey) => {
      const visible = presented.get(keyOf(key));
      if (visible !== undefined) emit({ type: "presentation", ...key, visible });
    },
    detach: (key: DesktopBrowserTabKey) => presented.delete(keyOf(key)),
  };
};
