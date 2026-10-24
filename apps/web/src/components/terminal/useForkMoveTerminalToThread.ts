import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useTerminalModeAvailable } from "../../hooks/useForkTerminalThreads";
import { useStableCallback } from "../../hooks/useStableCallback";
import { newThreadId } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { terminalEnvironment } from "../../state/terminal";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForAtomValue } from "../../state/waitForAtomValue";
import { stackedThreadToast, toastManager } from "../ui/toast";

const THREAD_SHELL_WAIT_MS = 5_000;

/**
 * Fork: turns a drawer terminal of `threadRef` into a new terminal thread and opens that thread.
 * The server moves the running shell, so the thread goes on with its process and output. Every
 * client drops the drawer tab when the server closes it there. Undefined while terminal threads
 * are off or the grants do not allow it.
 */
export function useForkMoveTerminalToThread(
  threadRef: ScopedThreadRef,
): ((terminalId: string) => void) | undefined {
  const available = useTerminalModeAvailable(threadRef.environmentId);
  const moveToThread = useAtomCommand(terminalEnvironment.moveToThread, { reportFailure: false });
  const navigate = useNavigate();
  const move = useStableCallback(async (terminalId: string) => {
    const threadId = newThreadId();
    const result = await moveToThread({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, terminalId, newThreadId: threadId },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not move the terminal",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }
    // The thread route needs the thread, which arrives on the thread stream after the call.
    await waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentThreadShells.threadShellAtom(
        scopeThreadRef(threadRef.environmentId, threadId),
      ),
      predicate: (thread) => thread !== null,
      timeoutMs: THREAD_SHELL_WAIT_MS,
    });
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: threadRef.environmentId, threadId },
    });
  });
  return available ? (terminalId) => void move(terminalId) : undefined;
}
