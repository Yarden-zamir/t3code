/**
 * Fork: machine map. MM-1922: each T3 tool call that this machine forwards over an arrow link goes
 * to the portal History: the target machine, the calling thread, the tool, the outcome and the
 * time. Never the arguments or the output. It wraps upstream `PeerForwarding`, so a forwarded wait
 * counts once, not once for each piece that upstream sends.
 */
import {
  type EnvironmentId,
  type MachineCallOutcome,
  type OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import { historyCaller } from "./machineCallerAccess.ts";
import * as MachineMap from "./MachineMap.ts";
import * as MachinePeers from "./MachinePeers.ts";

/** `refused`: the link or the other machine did not allow the call, so the tool did not run. */
const outcomeOf = (exit: Exit.Exit<unknown, OrchestratorMcpFailure>): MachineCallOutcome => {
  if (Exit.isSuccess(exit)) return "succeeded";
  const failure = Cause.findErrorOption(exit.cause);
  return Option.isSome(failure) && failure.value.code === "capability_denied"
    ? "refused"
    : "failed";
};

const make = Effect.gen(function* () {
  const upstream = yield* PeerForwarding.PeerForwarding;
  const machineMap = yield* MachineMap.MachineMap;
  const peers = yield* MachinePeers.MachinePeers;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;

  const reported = Effect.fn("MachineCallHistory.reported")(function* <A>(
    scope: McpInvocationContext.McpInvocationScope,
    environmentId: EnvironmentId,
    tool: string,
    call: Effect.Effect<A, OrchestratorMcpFailure>,
  ) {
    const at = DateTime.formatIso(yield* DateTime.now);
    const exit = yield* Effect.exit(call);
    const to = peers.machineOf(environmentId);
    // A call that never reached a machine of the map has no target to show.
    if (to !== undefined) {
      const caller = yield* historyCaller().pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(ThreadManagement.ThreadManagementService, threads),
      );
      yield* machineMap.reportCall({
        id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
        at,
        to,
        threadId: caller.threadId,
        threadTitle: caller.threadTitle,
        tool,
        outcome: outcomeOf(exit),
      });
    }
    return yield* exit;
  });

  return PeerForwarding.PeerForwarding.of({
    ...upstream,
    call: (scope, tool, environmentId, params) =>
      reported(scope, environmentId, tool.name, upstream.call(scope, tool, environmentId, params)),
    readThread: (scope, environmentId, input) =>
      reported(
        scope,
        environmentId,
        "t3_thread_read",
        upstream.readThread(scope, environmentId, input),
      ),
    interruptThread: (scope, environmentId, input) =>
      reported(
        scope,
        environmentId,
        "t3_thread_interrupt",
        upstream.interruptThread(scope, environmentId, input),
      ),
    waitForThread: (scope, environmentId, input) =>
      reported(
        scope,
        environmentId,
        "t3_thread_wait",
        upstream.waitForThread(scope, environmentId, input),
      ),
  });
});

/** Upstream `PeerForwarding`, with each forwarded call in the portal History (MM-1922). */
export const layer = Layer.effect(PeerForwarding.PeerForwarding, make).pipe(
  Layer.provide(PeerForwarding.layer),
);
