import { type MapToolName, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isMachineRequestNamespace } from "../../../fork/machineMap/machineAccess.ts";
import { historyCaller } from "../../../fork/machineMap/machineCallerAccess.ts";
import * as MachineExec from "../../../fork/machineMap/MachineExec.ts";
import * as MachineMap from "../../../fork/machineMap/MachineMap.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MachineMapToolkit } from "./tools.ts";

/**
 * An agent on another machine reaches this server through its arrow link. It must not use the map
 * role or the arrows of this machine, so a machine session gets none of these tools.
 */
const refuseMachineCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    isMachineRequestNamespace(scope.requestNamespace)
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Machine map tools are not available to another machine.",
          }),
        )
      : Effect.succeed(scope),
  ),
);

const toFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message: error.message });

/** MM-806: the portal records the calling thread and its title with each change. */
const callThroughPortal = Effect.fn("MachineMapMcp.callThroughPortal")(function* (
  tool: MapToolName,
  input: unknown,
) {
  yield* refuseMachineCaller;
  const machineMap = yield* MachineMap.MachineMap;
  return yield* machineMap
    .callMapTool({ tool, input, ...(yield* historyCaller()) })
    .pipe(Effect.mapError(toFailure));
});

export const layer = McpToolAccess.toLayer(MachineMapToolkit, {
  machines_read: McpToolAccess.reads(() => callThroughPortal("machines_read", {})),
  machines_resources: McpToolAccess.reads((input) =>
    callThroughPortal("machines_resources", input),
  ),
  machines_set_access: McpToolAccess.writesEnvironment((input) =>
    callThroughPortal("machines_set_access", input),
  ),
  machines_set_setting: McpToolAccess.writesEnvironment((input) =>
    callThroughPortal("machines_set_setting", input),
  ),
  machines_command: McpToolAccess.writesEnvironment((input) =>
    callThroughPortal("machines_command", input),
  ),
  machines_queue_cancel: McpToolAccess.writesEnvironment((input) =>
    callThroughPortal("machines_queue_cancel", input),
  ),
  machines_undo: McpToolAccess.writesEnvironment((input) =>
    callThroughPortal("machines_undo", input),
  ),
  machines_preset: McpToolAccess.writesEnvironment((input) =>
    callThroughPortal("machines_preset", input),
  ),
  // Joining changes the settings and the auth of this server, like an environment setting.
  machines_join: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* refuseMachineCaller;
      // MM-919: joining sets the portal and turns the map on, so an agent never does it.
      // `t3 machine-map join` on a headless machine has no thread. A joined machine refuses a
      // second join while the map is on (`MachineMap.join`).
      if (scope.thread !== undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Agents do not join the machine map. Run t3 machine-map join on the machine.",
        });
      }
      const machineMap = yield* MachineMap.MachineMap;
      return yield* machineMap.join(input).pipe(Effect.mapError(toFailure));
    }),
  ),
  // MM-1908: the one map tool that a machine session may call. The service checks the arrow:
  // here it needs a live full-access/default caller, and a machine session needs the exec arrow.
  // The link access of the level does not limit it, so linked callers pass this declaration.
  machine_exec: McpToolAccess.writes(
    (input) =>
      MachineExec.MachineExec.pipe(
        Effect.flatMap((machineExec) => machineExec.exec(input)),
        Effect.catchTags({ MachinePeerError: (error) => Effect.fail(toFailure(error)) }),
      ),
    { linkedCallers: "allowed" },
  ),
});
