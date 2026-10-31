import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { assertFullAccess, assertLiveCaller, readCaller } from "../../mcp/threadAccess.ts";
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
