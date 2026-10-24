import { useEffect, type RefObject } from "react";

import { makeForkBrowserSurfaceCapture } from "./forkBrowserSurfaceCapture";

// Fork: acknowledge the committed on-screen placement, not document.visibilityState.
export const useForkBrowserCapture = (
  threadId: string,
  tabId: string,
  runtimeTabId: string,
  serverDriven: boolean,
  visible: boolean,
  wrapper: RefObject<HTMLDivElement | null>,
) => {
  const reportPresentation = () =>
    window.desktopBridge?.preview?.forkCapture?.report({
      type: "presentation",
      threadId,
      tabId,
      visible,
    });
  useEffect(() => {
    if (serverDriven) void reportPresentation()?.catch(() => {});
  }, [serverDriven, reportPresentation]);
  useEffect(() => {
    const bridge = window.desktopBridge?.preview?.forkCapture;
    if (!serverDriven || !bridge) return;
    const placed = (signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        let frameId: number;
        const finish = (paintable: boolean) => {
          cancelAnimationFrame(frameId);
          signal.removeEventListener("abort", abort);
          resolve(paintable);
        };
        const abort = () => finish(false);
        signal.addEventListener("abort", abort, { once: true });
        const secondFrame = () => {
          frameId = requestAnimationFrame(() => {
            const element = wrapper.current;
            const rect = element?.getBoundingClientRect();
            finish(
              Boolean(
                element?.isConnected &&
                rect &&
                rect.x >= 0 &&
                rect.y >= 0 &&
                rect.width > 0 &&
                rect.height > 0 &&
                getComputedStyle(element).visibility !== "hidden",
              ),
            );
          });
        };
        frameId = requestAnimationFrame(secondFrame);
      });
    const capture = makeForkBrowserSurfaceCapture(runtimeTabId, bridge.report, placed);
    const unsubscribe = bridge.onLease((command) => {
      if (command.threadId === threadId && command.tabId === tabId) capture.lease(command);
    });
    return () => {
      unsubscribe();
      capture.dispose();
      void bridge.report({ type: "presentation", threadId, tabId, visible: false }).catch(() => {});
    };
  }, [runtimeTabId, serverDriven, tabId, threadId, wrapper]);
  return reportPresentation;
};
