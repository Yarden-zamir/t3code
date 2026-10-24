import * as Schema from "effect/Schema";

const TabKey = { threadId: Schema.String, tabId: Schema.String };

// Fork: the native surface is not a streamed viewer. Capture activity must not imply visibility.
export const ForkBrowserPresentation = Schema.Struct({
  type: Schema.Literal("presentation"),
  ...TabKey,
  visible: Schema.Boolean,
});
export const ForkBrowserCaptureReady = Schema.Struct({
  type: Schema.Literal("captureReady"),
  ...TabKey,
  requestId: Schema.String,
});
export const ForkBrowserCaptureCommand = Schema.Struct({
  type: Schema.Literal("capture"),
  ...TabKey,
  requestId: Schema.String,
  active: Schema.Boolean,
});
export type ForkBrowserCaptureCommand = typeof ForkBrowserCaptureCommand.Type;
export const ForkBrowserCaptureReport = Schema.Union([
  ForkBrowserPresentation,
  ForkBrowserCaptureReady,
]);
export type ForkBrowserCaptureReport = typeof ForkBrowserCaptureReport.Type;

export interface ForkBrowserCaptureBridge {
  readonly forkCapture?: {
    readonly report: (event: ForkBrowserCaptureReport) => Promise<void>;
    readonly onLease: (listener: (command: ForkBrowserCaptureCommand) => void) => () => void;
  };
}

export const ForkSnapshotStage = Schema.Literals([
  "rendering placement",
  "metrics",
  "password fields",
  "page text",
  "screenshot",
  "accessibility tree",
]);
export type ForkSnapshotStage = typeof ForkSnapshotStage.Type;
export const ForkSnapshotTimeout = Schema.Struct({
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  stage: ForkSnapshotStage,
});
