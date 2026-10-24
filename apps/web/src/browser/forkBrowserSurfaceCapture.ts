import type {
  ForkBrowserCaptureCommand,
  ForkBrowserCaptureReport,
} from "@t3tools/contracts/forkBrowserCapture";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";

// Fork: a server timeout or disconnect must not leave a guest compositing forever.
const CAPTURE_LEASE_MS = 12_000;

export const makeForkBrowserSurfaceCapture = (
  runtimeTabId: string,
  report: (event: ForkBrowserCaptureReport) => Promise<void>,
  placed: (signal: AbortSignal) => Promise<boolean>,
) => {
  const leases = new Map<string, () => void>();
  const release = (requestId: string) => leases.get(requestId)?.();
  return {
    lease: (command: ForkBrowserCaptureCommand) => {
      if (!command.active) return release(command.requestId);
      if (leases.has(command.requestId)) return;
      const controller = new AbortController();
      const activity = acquireBrowserSurfaceActivity(runtimeTabId);
      const timer = setTimeout(() => release(command.requestId), CAPTURE_LEASE_MS);
      leases.set(command.requestId, () => {
        clearTimeout(timer);
        leases.delete(command.requestId);
        controller.abort();
        activity();
      });
      void placed(controller.signal)
        .then((paintable) => {
          if (paintable && leases.has(command.requestId)) {
            return report({
              type: "captureReady",
              threadId: command.threadId,
              tabId: command.tabId,
              requestId: command.requestId,
            });
          }
        })
        .catch(() => release(command.requestId));
    },
    dispose: () => {
      for (const release of leases.values()) release();
    },
  };
};
