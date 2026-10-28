import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as KitshnPublish from "../../../fork/kitshn/KitshnPublish.ts";
import { isMachineRequestNamespace } from "../../../fork/machineMap/machineAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { KitshnToolkit } from "./tools.ts";

/** The key and the files belong to this machine, so an agent on another machine gets none. */
const callingThread = Effect.fn("KitshnMcp.callingThread")(function* (operation: string) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (isMachineRequestNamespace(scope.requestNamespace)) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "kitshn tools are not available to another machine.",
    });
  }
  return (yield* McpInvocationContext.requireThreadScope(scope, operation)).thread;
});

const toFailure = (error: KitshnPublish.KitshnPublishError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "no_key" || error.reason === "outside_workspace"
        ? "capability_denied"
        : "invalid_request",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(KitshnToolkit, {
  kitshn_publish: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const thread = yield* callingThread("kitshn_publish");
      const kitshn = yield* KitshnPublish.KitshnPublish;
      return yield* kitshn.publish(thread.threadId, input).pipe(Effect.mapError(toFailure));
    }),
  ),
  kitshn_address: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      yield* callingThread("kitshn_address");
      const kitshn = yield* KitshnPublish.KitshnPublish;
      return yield* kitshn.address(input).pipe(Effect.mapError(toFailure));
    }),
  ),
  kitshn_agent_key: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const thread = yield* callingThread("kitshn_agent_key");
      const kitshn = yield* KitshnPublish.KitshnPublish;
      if (input.action === "status")
        return yield* kitshn.keyStatus.pipe(Effect.mapError(toFailure));
      if (input.action === "clear") return yield* kitshn.clearKey.pipe(Effect.mapError(toFailure));
      if (
        input.server === undefined ||
        input.clientIdRef === undefined ||
        input.clientSecretRef === undefined
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "set needs server, clientIdRef and clientSecretRef.",
        });
      }
      return yield* kitshn
        .setKey({
          threadId: thread.threadId,
          server: input.server,
          clientIdRef: input.clientIdRef,
          clientSecretRef: input.clientSecretRef,
        })
        .pipe(Effect.mapError(toFailure));
    }),
  ),
});
