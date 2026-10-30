import {
  type ModelSelection,
  OrchestratorMcpFailure,
  TERMINAL_THREAD_INSTANCE_ID,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as KitshnGrants from "../kitshn/KitshnGrants.ts";
import { machineOfRequestNamespace } from "./machineAccess.ts";

type RunsWith = Pick<ModelSelection, "instanceId">;

/**
 * Fork (MM-1923): a terminal thread types messages into a shell, so a launch, send, interrupt or
 * terminal scheduled task runs shell commands, as `machine_exec` does. A machine session needs
 * kitshn's "runs commands" on this machine (K-722); metadata writes skip this (`metadataOnly`). `runsWith` is the work model,
 * an effect that resolves only for a machine session without exec, so others never pay for it.
 */
export const refuseTerminalThreadWithoutExec = Effect.fn("refuseTerminalThreadWithoutExec")(
  function* <E = never, R = never>(
    requestNamespace: string,
    runsWith: RunsWith | Effect.Effect<RunsWith, E, R>,
  ) {
    const from = machineOfRequestNamespace(requestNamespace);
    if (from === undefined) return;
    const grants = yield* Effect.serviceOption(KitshnGrants.KitshnGrants);
    if (Option.isSome(grants) && (yield* grants.value.machineMayExec(from))) return;
    const model = Effect.isEffect(runsWith) ? yield* runsWith : runsWith;
    if (model.instanceId !== TERMINAL_THREAD_INSTANCE_ID) return;
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        'A terminal thread runs its messages in a shell, so a call from another machine that runs or stops code in one needs kitshn\'s "runs commands" on this machine at automatic. The owner sets it on the kitshn map.',
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
