import { ForkSnapshotTimeout } from "@t3tools/contracts/forkBrowserCapture";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeTimeout = Schema.decodeUnknownOption(ForkSnapshotTimeout);

// Fork: only structured capture diagnostics can override the transport deadline.
export const forkPreviewCaptureTimeout = (detail: unknown) => {
  const decoded = decodeTimeout(detail);
  return Option.isSome(decoded)
    ? { timeoutMs: decoded.value.timeoutMs, captureStage: decoded.value.stage }
    : {};
};
