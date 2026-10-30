import {
  OrchestratorMcpFailure,
  type ProviderInstanceId,
  TERMINAL_THREAD_INSTANCE_ID,
  TERMINAL_THREADS_OFF_MESSAGE,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ServerSettingsService } from "../../serverSettings.ts";

/**
 * Fork: while `terminalThreads` is off the `terminal` instance is not hydrated, so a terminal
 * thread would only fail at its first run with a generic session error. Agent tools refuse first.
 */
export const refuseTerminalThreadWhileOff = Effect.fn("refuseTerminalThreadWhileOff")(function* (
  instanceId: ProviderInstanceId,
) {
  if (instanceId !== TERMINAL_THREAD_INSTANCE_ID) return;
  const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
    ),
  );
  if (settings.terminalThreads) return;
  return yield* new OrchestratorMcpFailure({
    code: "provider_unavailable",
    message: TERMINAL_THREADS_OFF_MESSAGE,
  });
});
