import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as KitshnCli from "../../../fork/kitshn/KitshnCli.ts";
import * as KitshnConnection from "../../../fork/kitshn/KitshnConnection.ts";
import * as KitshnGrants from "../../../fork/kitshn/KitshnGrants.ts";
import * as KitshnProvider from "../../../fork/kitshn/KitshnProvider.ts";
import * as KitshnSettingsSync from "../../../fork/kitshn/KitshnSettingsSync.ts";
import { isMachineRequestNamespace } from "../../../fork/machineMap/machineAccess.ts";
import * as MachineExec from "../../../fork/machineMap/MachineExec.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MachineMapToolkit } from "./tools.ts";

/**
 * An agent on another machine reaches this server through a link. It must not ask kitshn as this
 * machine, so a machine session gets none of these tools.
 */
const refuseMachineCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.filterOrFail(
    (scope) => !isMachineRequestNamespace(scope.requestNamespace),
    () =>
      new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "The machine tools are not available to another machine.",
      }),
  ),
);

const toFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message: error.message });

const ask = <I extends KitshnConnection.LocalRequestInput>(request: I) =>
  refuseMachineCaller.pipe(
    Effect.andThen(KitshnConnection.KitshnConnection),
    Effect.flatMap((kitshn) => kitshn.request(request)),
    Effect.mapError(toFailure),
  );

/** K-709: set or clear one key of one part of the `t3.settings` state. */
const setSetting = Effect.fn("MachineMapMcp.setSetting")(function* (
  input: typeof import("./tools.ts").MachinesSetSettingInput.Type,
) {
  const scope = yield* refuseMachineCaller;
  // A thread is an agent; `t3 tool call` without a thread credential is the owner in a shell.
  yield* (yield* KitshnSettingsSync.KitshnSettingsSync)
    .setOne(
      {
        part: input.part,
        scope: input.scope,
        key: input.key,
        value: input.clear === true ? undefined : input.value,
      },
      scope.thread === undefined ? "owner" : "agent",
    )
    .pipe(Effect.mapError(toFailure));
  return { _tag: "setting", part: input.part, scope: input.scope, key: input.key };
});

export const layer = McpToolAccess.toLayer(MachineMapToolkit, {
  machines_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* refuseMachineCaller;
      const grants = yield* KitshnGrants.KitshnGrants;
      const provider = yield* KitshnProvider.KitshnProvider;
      const machineExec = yield* MachineExec.MachineExec;
      // K-1611: the connection shows also when kitshn cannot answer the state ask.
      const answer = yield* ask({ type: "ask", action: "state", target: "" }).pipe(Effect.result);
      const connection = yield* provider.connection.pipe(Stream.runHead);
      const state = yield* provider.state.pipe(Stream.runHead);
      return {
        _tag: "read",
        machine: yield* grants.machine,
        connection: {
          ...Option.getOrNull(connection),
          linkProxy: (yield* provider.linkSocket) !== null,
          syncedAt: Option.isSome(state) ? state.value.syncedAt : null,
          paused: Option.isSome(state) && state.value.paused,
          problems: Option.isSome(state) ? state.value.problems : [],
        },
        state:
          answer._tag === "Success" && "result" in answer.success ? answer.success.result : null,
        stateError: answer._tag === "Failure" ? answer.failure.message : null,
        askResults: yield* provider.askResults,
        jobResults: yield* provider.jobResults,
        execResults: Option.getOrElse(
          yield* machineExec.lateResults.pipe(Stream.runHead),
          () => [],
        ),
      };
    }),
  ),
  machines_resources: McpToolAccess.reads(() =>
    ask({ type: "samples" }).pipe(
      Effect.map((answer) => ({
        _tag: "resources",
        newest: answer.newest,
        history: answer.history,
      })),
    ),
  ),
  machines_set_setting: McpToolAccess.writesEnvironment(setSetting),
  machines_command: McpToolAccess.writesEnvironment((input) =>
    ask({
      type: "ask",
      action: "job",
      target: input.machineId,
      body: {
        command: {
          kind: "provider",
          provider: "t3",
          command: input.command,
          resource: input.resource ?? "app",
          ...(input.row === undefined ? {} : { row: input.row }),
        },
      },
    }).pipe(
      Effect.flatMap((answer): Effect.Effect<unknown, OrchestratorMcpFailure> => {
        switch (answer.outcome) {
          case "done":
            return Effect.succeed({ _tag: "command", outcome: "done", result: answer.result });
          case "waiting":
            return Effect.succeed({
              _tag: "command",
              outcome: "waiting",
              proposalId: answer.proposalId,
            });
          case "refused":
          case "not-kitshn":
            return Effect.fail(toFailure({ message: answer.reason }));
        }
      }),
    ),
  ),
  machines_queue_cancel: McpToolAccess.writesEnvironment((input) =>
    ask({ type: "job-cancel", jobId: input.jobId }).pipe(
      Effect.as({ _tag: "cancelled", jobId: input.jobId }),
    ),
  ),
  // Joining changes the auth of this server, like an environment setting.
  machines_join: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* refuseMachineCaller;
      // K-1603: an agent never joins a machine. `t3 tool call` from a shell has no thread.
      if (scope.thread !== undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Agents do not join kitshn. Run kitshn join on the machine.",
        });
      }
      const cli = yield* KitshnCli.KitshnCli;
      const output = yield* cli.join(input).pipe(Effect.mapError(toFailure));
      if (output.exitCode !== 0) {
        return yield* toFailure({
          message:
            KitshnCli.lastLine(output.stderr) ?? `kitshn join exited with ${output.exitCode}.`,
        });
      }
      return { _tag: "joined", output: output.stdout.trim() };
    }),
  ),
  // MM-1908: the service needs a live full-access/default caller of this machine; kitshn checks
  // "runs commands" (K-722).
  machine_exec: McpToolAccess.writes((input) =>
    MachineExec.MachineExec.pipe(Effect.flatMap((machineExec) => machineExec.exec(input))),
  ),
});
