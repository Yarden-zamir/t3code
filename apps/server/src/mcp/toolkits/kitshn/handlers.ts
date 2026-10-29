import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as KitshnPublish from "../../../fork/kitshn/KitshnPublish.ts";
import { isMachineRequestNamespace } from "../../../fork/machineMap/machineAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { KitshnToolkit } from "./tools.ts";

/**
 * The daemon and the files belong to this machine, so an agent on another machine gets none. A call
 * needs the thread's own credential: without it kitshn would see only the bare machine, not a thread.
 */
export const callingThread = Effect.fn("KitshnMcp.callingThread")(function* (operation: string) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (isMachineRequestNamespace(scope.requestNamespace)) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "kitshn tools are not available to another machine.",
    });
  }
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, operation);
  if (scope.threadAuthorization === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `${operation} needs the MCP credential of an agent thread on this machine, so kitshn knows the thread that asks.`,
    });
  }
  return { threadId: thread.threadId, authorization: scope.threadAuthorization };
});

const toFailure = (error: KitshnPublish.KitshnPublishError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "outside_workspace" ? "capability_denied" : "invalid_request",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(KitshnToolkit, {
  kitshn_publish: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const caller = yield* callingThread("kitshn_publish");
      const kitshn = yield* KitshnPublish.KitshnPublish;
      return yield* kitshn
        .publish(caller.threadId, caller.authorization, input)
        .pipe(Effect.mapError(toFailure));
    }),
  ),
  kitshn_address: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const caller = yield* callingThread("kitshn_address");
      const kitshn = yield* KitshnPublish.KitshnPublish;
      return yield* kitshn.address(caller.authorization, input).pipe(Effect.mapError(toFailure));
    }),
  ),
});
