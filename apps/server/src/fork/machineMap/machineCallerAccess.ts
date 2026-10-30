import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { assertFullAccess, assertLiveCaller, readCaller } from "../../mcp/threadAccess.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import {
  CLI_LOCAL_USER_REFUSAL,
  isCliLocalUser,
  isMachineRequestNamespace,
  MACHINE_MCP_CAPABILITIES,
} from "./machineAccess.ts";

/**
 * MM-1908: `machine_exec` runs a shell as the user of the other machine, past every T3 mode, so
 * only a live full-access/default caller with every tool capability may send it. Returns that
 * caller, so its limits go out with the call.
 */
export const requireMachineExecCaller = Effect.fn("MachinePeers.requireMachineExecCaller")(
  function* () {
    const caller = yield* readCaller();
    if (isCliLocalUser(caller.scope)) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: CLI_LOCAL_USER_REFUSAL,
      });
    }
    yield* assertLiveCaller(caller);
    yield* assertFullAccess(
      caller,
      "machine_exec needs a live full-access/default caller. Restricted callers cannot borrow a machine's access.",
    );
    if (
      isMachineRequestNamespace(caller.scope.requestNamespace) ||
      MACHINE_MCP_CAPABILITIES.some((capability) => !caller.scope.capabilities.has(capability))
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message:
          "machine_exec cannot grant missing tool capabilities or use another machine's links.",
      });
    }
    return caller;
  },
);

/**
 * MM-806, MM-1920: the caller that the portal History names. A caller without a thread is an MCP
 * client session, so History shows its label: "CLI (local user)" for `t3 tool call`. The label
 * goes in `threadTitle`, so the portal needs no change; a caller kind in the contract would
 * replace this once History shows more caller kinds than threads and clients.
 */
export const historyCaller = Effect.fn("MachinePeers.historyCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threadId = scope.thread?.threadId ?? null;
  if (threadId === null) {
    return { threadId, threadTitle: scope.client?.label ?? null };
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
  return { threadId, threadTitle: shell?.title ?? null };
});
