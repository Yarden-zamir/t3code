import {
  isTerminalThread,
  terminalThreadShell,
  type TerminalAttachInput,
  type TerminalOpenInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { isTerminalThreadMainTerminal } from "./shellIntegration.ts";

/**
 * Fork: the main terminal of a terminal thread runs the shell of the thread, whichever client
 * opens it. A client that names no shell (mobile, an older web client) would otherwise start the
 * default shell, and a terminal that runs restarts on a different shell. A draft terminal has no
 * thread yet, so its client names the shell itself.
 */
export function withTerminalThreadShell<Input extends TerminalOpenInput | TerminalAttachInput>(
  threads: ThreadManagement.ThreadManagementService["Service"],
  input: Input,
): Effect.Effect<Input> {
  if (
    input.shell !== undefined ||
    !isTerminalThreadMainTerminal(input.terminalId, input.env ?? null)
  ) {
    return Effect.succeed(input);
  }
  return threads.getThreadShell(ThreadId.make(input.threadId)).pipe(
    Effect.map((thread) => {
      const shell =
        thread !== null && isTerminalThread(thread)
          ? terminalThreadShell(thread.modelSelection.model)
          : undefined;
      return shell === undefined ? input : { ...input, shell };
    }),
    // Without the thread, the client's input stands, as it did before this fill.
    Effect.orElseSucceed(() => input),
  );
}
