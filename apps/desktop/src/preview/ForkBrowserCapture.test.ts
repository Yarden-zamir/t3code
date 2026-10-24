import { expect, it, vi } from "vite-plus/test";
import type { ForkBrowserCaptureReport } from "@t3tools/contracts/forkBrowserCapture";

import { makeForkBrowserCapture } from "./ForkBrowserCapture.ts";

const key = { threadId: "thread", tabId: "tab" };

it("trusts only the guest's host renderer and replays presentation without capture visibility", () => {
  const send = vi.fn();
  const reports: ForkBrowserCaptureReport[] = [];
  const guest = {
    hostWebContents: { id: 17, isDestroyed: () => false, send },
  } as unknown as Electron.WebContents;
  const capture = makeForkBrowserCapture(
    (report) => reports.push(report),
    (candidate) =>
      candidate.threadId === key.threadId && candidate.tabId === key.tabId
        ? { webContents: guest, debugger: {} as Electron.Debugger }
        : undefined,
  );
  const presented = { type: "presentation", ...key, visible: true } as const;
  capture.report(presented, 999);
  expect(reports).toEqual([]);
  capture.report(presented, 17);
  capture.announce(key);
  expect(reports).toEqual([presented, presented]);
  const command = { type: "capture", ...key, requestId: "capture-1", active: true } as const;
  capture.command(command);
  expect(send).toHaveBeenCalledWith("fork:browser-capture", command);
  expect(reports).toHaveLength(2);
  capture.detach(key);
  capture.announce(key);
  expect(reports).toHaveLength(2);
});
