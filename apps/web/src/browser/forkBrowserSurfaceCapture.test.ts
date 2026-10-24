import { expect, it, vi } from "vite-plus/test";

import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { makeForkBrowserSurfaceCapture } from "./forkBrowserSurfaceCapture";

const key = { threadId: "thread", tabId: "tab" };
const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: A) => resolve(value) };
};

it("keeps overlapping captures active, acknowledges placement, and releases only its own leases", async () => {
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  const first = deferred<boolean>();
  const second = deferred<boolean>();
  const acknowledged = deferred<void>();
  const report = vi.fn(async () => acknowledged.resolve());
  const capture = makeForkBrowserSurfaceCapture(
    "native-tab",
    report,
    vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
  );
  try {
    capture.lease({ type: "capture", ...key, requestId: "first", active: true });
    capture.lease({ type: "capture", ...key, requestId: "second", active: true });
    expect(report).not.toHaveBeenCalled();
    expect(useBrowserSurfaceStore.getState().activityByTabId["native-tab"]).toBe(2);
    capture.lease({ type: "capture", ...key, requestId: "first", active: false });
    first.resolve(true);
    second.resolve(true);
    await acknowledged.promise;
    expect(report).toHaveBeenCalledExactlyOnceWith({
      type: "captureReady",
      ...key,
      requestId: "second",
    });
    expect(useBrowserSurfaceStore.getState().activityByTabId["native-tab"]).toBe(1);
    expect(useBrowserSurfaceStore.getState().byTabId["native-tab"]?.visible).not.toBe(true);
  } finally {
    capture.dispose();
  }
  expect(useBrowserSurfaceStore.getState().activityByTabId["native-tab"]).toBeUndefined();
});

it("bounds an abandoned capture lease when its server cannot release it", () => {
  vi.useFakeTimers();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  const capture = makeForkBrowserSurfaceCapture(
    "abandoned",
    async () => {},
    () => new Promise(() => {}),
  );
  try {
    capture.lease({ type: "capture", ...key, requestId: "abandoned", active: true });
    vi.runAllTimers();
    expect(useBrowserSurfaceStore.getState().activityByTabId["abandoned"]).toBeUndefined();
  } finally {
    capture.dispose();
    vi.useRealTimers();
  }
});

it("releases activity and cancels placement after placement fails", async () => {
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  const released = deferred<void>();
  const report = vi.fn(async () => {});
  const capture = makeForkBrowserSurfaceCapture("failed", report, (signal) => {
    signal.addEventListener("abort", () => released.resolve());
    return Promise.reject(new Error("guest detached"));
  });
  try {
    capture.lease({ type: "capture", ...key, requestId: "failed", active: true });
    await released.promise;
    expect(useBrowserSurfaceStore.getState().activityByTabId["failed"]).toBeUndefined();
    expect(report).not.toHaveBeenCalled();
  } finally {
    capture.dispose();
  }
});
