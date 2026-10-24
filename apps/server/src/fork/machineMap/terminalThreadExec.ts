import {
  type ModelSelection,
  OrchestratorMcpFailure,
  TERMINAL_THREAD_INSTANCE_ID,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { execArrowInto, machineOfRequestNamespace } from "./machineAccess.ts";
import * as MachineMapState from "./MachineMapState.ts";

type RunsWith = Pick<ModelSelection, "instanceId">;

/**
 * Fork (MM-1923): a terminal thread types each message into a shell, so a launch of one, a send or
 * an interrupt to one or a terminal scheduled task runs or stops shell commands, as `machine_exec`
 * does. A call from another machine (a machine session) may do that only through an arrow that
 * allows exec. Metadata writes skip this check (`metadataOnly` in `McpToolAccess.writesThreads`).
 * Other callers keep their mode checks only. `runsWith` is the model that the work runs with. An effect
 * resolves it only for a machine session without exec, so other callers never pay for it.
 */
export const refuseTerminalThreadWithoutExec = Effect.fn("refuseTerminalThreadWithoutExec")(
  function* <E = never, R = never>(
    requestNamespace: string,
    runsWith: RunsWith | Effect.Effect<RunsWith, E, R>,
  ) {
    const from = machineOfRequestNamespace(requestNamespace);
    if (from === undefined) return;
    const state = yield* Effect.serviceOption(MachineMapState.MachineMapState);
    const desired = Option.isSome(state) ? yield* state.value.activeDesired : null;
    const nowMs = yield* Clock.currentTimeMillis;
    if (desired !== null && execArrowInto(desired, from, nowMs) !== undefined) return;
    const model = Effect.isEffect(runsWith) ? yield* runsWith : runsWith;
    if (model.instanceId !== TERMINAL_THREAD_INSTANCE_ID) return;
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "A terminal thread runs its messages in a shell, so a call from another machine that runs or stops code in one needs an arrow with exec, agent tools and the level standard or admin. The owner can turn exec on in the machine map.",
    });
  },
);

/**
 * The model that a scheduled task runs with. A bound run goes to its thread with no model of its
 * own, so it runs with the model of that thread, also when the task names an agent. A thread that
 * cannot be read counts as a terminal thread, so a doubt refuses.
 */
export const scheduledTaskRunsWith = Effect.fn("scheduledTaskRunsWith")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">,
  task: { readonly threadId: ThreadId | null; readonly modelSelection: RunsWith },
) {
  const { threadId } = task;
  if (threadId === null) return task.modelSelection;
  return yield* threads.getThreadShell(threadId).pipe(
    Effect.map((thread): RunsWith => thread?.modelSelection ?? task.modelSelection),
    Effect.orElseSucceed((): RunsWith => ({ instanceId: TERMINAL_THREAD_INSTANCE_ID })),
  );
});
