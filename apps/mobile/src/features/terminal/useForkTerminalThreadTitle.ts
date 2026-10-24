import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_TERMINAL_ID,
  isTerminalThread,
  terminalThreadCommandTitle,
  terminalThreadShell,
} from "@t3tools/contracts";
import { useEffect } from "react";

import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";

/**
 * Fork: a terminal thread that started without a command (New terminal thread on mobile, the
 * enlarge button on web) is named after its first command, as the web screen of the thread does.
 */
export function useForkTerminalThreadTitle(thread: EnvironmentThreadShell | null): void {
  const terminalThread = thread !== null && isTerminalThread(thread) ? thread : null;
  const { sessions } = useKnownTerminalSessions({
    environmentId: terminalThread?.environmentId ?? null,
    threadId: terminalThread?.id ?? null,
  });
  const command = sessions?.find((known) => known.target.terminalId === DEFAULT_TERMINAL_ID)?.state
    .summary?.command;
  const commandTitle =
    terminalThread === null
      ? null
      : terminalThreadCommandTitle({
          title: terminalThread.title,
          command,
          shell: terminalThreadShell(terminalThread.modelSelection.model),
        });
  const canRename = useEnvironmentScope(
    terminalThread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const environmentId = terminalThread?.environmentId;
  const threadId = terminalThread?.id;
  useEffect(() => {
    if (commandTitle === null || !canRename || !environmentId || !threadId) return;
    void updateMetadata({ environmentId, input: { threadId, title: commandTitle } });
  }, [canRename, commandTitle, environmentId, threadId, updateMetadata]);
}
