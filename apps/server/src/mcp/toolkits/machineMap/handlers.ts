import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as KitshnCli from "../../../fork/kitshn/KitshnCli.ts";
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

const ask = (
  request: KitshnProvider.KitshnProvider["Service"] extends {
    readonly request: (input: infer I) => unknown;
  }
    ? I
    : never,
) =>
  refuseMachineCaller.pipe(
    Effect.andThen(KitshnProvider.KitshnProvider),
    Effect.flatMap((provider) => provider.request(request)),
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
      // K-1611: the connection shows also when kitshn cannot answer the state ask.
      const answer = yield* ask({ type: "ask", action: "state", target: "" }).pipe(Effect.result);
      const connection = yield* provider.connection.pipe(Stream.runHead);
      const grantState = yield* grants.state;
      return {
        _tag: "read",
        machine: yield* grants.machine,
        connection: {
          ...Option.getOrNull(connection),
          linkProxy: yield* provider.linkProxyState,
          lastContactAt: grantState.lastContactAt,
          paused: yield* grants.paused,
        },
        state:
          answer._tag === "Success" && "result" in answer.success ? answer.success.result : null,
        stateError: answer._tag === "Failure" ? answer.failure.message : null,
        askResults: yield* provider.askResults,
      };
    }),
  ),
  machines_resources: McpToolAccess.reads(() =>
    ask({ type: "samples" }).pipe(
      Effect.map((answer) =>
        answer.type === "samples"
          ? { _tag: "resources", newest: answer.newest, history: answer.history }
          : { _tag: "resources", newest: null, history: [] },
      ),
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
      Effect.flatMap((answer) => {
        if (answer.type !== "ask") return Effect.succeed({ _tag: "command", outcome: "done" });
        switch (answer.outcome) {
          case "done":
            return Effect.succeed({ _tag: "command", outcome: "done", result: answer.result });
          case "waiting":
            return Effect.succeed({
              _tag: "command",
              outcome: "waiting",
              proposalId: answer.proposalId ?? null,
            });
          default:
            return Effect.fail(toFailure({ message: answer.reason ?? "kitshn refused the job." }));
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
  // MM-1908: the one machine tool that a machine session may call. The service checks the grants:
  // here it needs a live full-access/default caller, and a machine session needs the exec grant.
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
