import { ForkBrowserCaptureReport } from "@t3tools/contracts/forkBrowserCapture";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopBrowserHost from "../../preview/DesktopBrowserHost.ts";
import { FORK_BROWSER_CAPTURE_REPORT_CHANNEL } from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const reportBrowserCapture = DesktopIpc.makeIpcMethod({
  channel: FORK_BROWSER_CAPTURE_REPORT_CHANNEL,
  payload: ForkBrowserCaptureReport,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.captureReport")(function* (report, event) {
    const host = yield* DesktopBrowserHost.DesktopBrowserHost;
    host.forkCapture.report(report, event?.sender.id);
  }),
});
