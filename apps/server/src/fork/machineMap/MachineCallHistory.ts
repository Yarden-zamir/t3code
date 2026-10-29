/**
 * Fork: MM-1922 on kitshn (K-1610): each T3 tool call that this machine forwards over a link goes
 * to the kitshn audit: the target machine, the calling thread, the tool, the outcome and the time.
 * Never the arguments or the output. It wraps upstream `PeerForwarding`, so a forwarded wait
 * counts once, not once for each piece that upstream sends.
 */
import {
  type EnvironmentId,
  type MachineCallOutcome,
  type OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import { historyCaller } from "./machineCallerAccess.ts";
import * as KitshnAudit from "../kitshn/KitshnAudit.ts";
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
  const audit = yield* KitshnAudit.KitshnAudit;
  const peers = yield* MachinePeers.MachinePeers;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const reported = Effect.fn("MachineCallHistory.reported")(function* <A>(
    scope: McpInvocationContext.McpInvocationScope,
    environmentId: EnvironmentId,
    tool: string,
    call: Effect.Effect<A, OrchestratorMcpFailure>,
  ) {
    const exit = yield* Effect.exit(call);
    const to = peers.machineOf(environmentId);
    // A call that never reached a machine of the map has no target to show.
    if (to !== undefined) {
      const caller = yield* historyCaller().pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(ThreadManagement.ThreadManagementService, threads),
      );
      yield* audit.report({
        kind: "tool",
        target: to,
        thread: caller.threadId,
        name: tool,
        cwd: null,
        outcome: outcomeOf(exit),
        exitCode: null,
      });
    }
    return yield* exit;
  });

  // Forwarders retain the `MachineCallHistory.reported` and upstream operation spans.
  return PeerForwarding.PeerForwarding.of({
    ...upstream,
    call: Effect.fnUntraced(function* (scope, tool, environmentId, params) {
      return yield* reported(
        scope,
        environmentId,
        tool.name,
        upstream.call(scope, tool, environmentId, params),
      );
    }),
    readThread: Effect.fnUntraced(function* (scope, environmentId, input) {
      return yield* reported(
        scope,
        environmentId,
        "t3_thread_read",
        upstream.readThread(scope, environmentId, input),
      );
    }),
    interruptThread: Effect.fnUntraced(function* (scope, environmentId, input) {
      return yield* reported(
        scope,
        environmentId,
        "t3_thread_interrupt",
        upstream.interruptThread(scope, environmentId, input),
      );
    }),
    waitForThread: Effect.fnUntraced(function* (scope, environmentId, input) {
      return yield* reported(
        scope,
        environmentId,
        "t3_thread_wait",
        upstream.waitForThread(scope, environmentId, input),
      );
    }),
  });
});

/** Upstream `PeerForwarding`, with each forwarded call in the portal History (MM-1922). */
export const layer = Layer.effect(PeerForwarding.PeerForwarding, make).pipe(
  Layer.provide(PeerForwarding.layer),
);
