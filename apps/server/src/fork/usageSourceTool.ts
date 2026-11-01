import {
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  SecretRef,
  TrimmedNonEmptyString,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import type { toolkitRegistration } from "../mcp/McpHttpServer.ts";
import { readCaller } from "../mcp/threadAccess.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import { localUsageHubUrl } from "./usageSourceAdd.ts";
import { MAX_USAGE_SOURCE_KEY_BYTES, readUsageSourceKey } from "./usageSourceKey.ts";

const UsageSourceAddTool = Tool.make("t3_usage_source_add", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  description:
    "Add a local CLIProxyAPI usage hub. Loopback URL; exactly one of secretRef or keyFile (owner-only POSIX file). The key is never returned.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    url: TrimmedNonEmptyString,
    label: Schema.optional(TrimmedNonEmptyString),
    secretRef: Schema.optional(SecretRef),
    keyFile: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({ id: UsageLimitSourceId }),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Environment.ServerEnvironment,
    ThreadCommandExecutor.ThreadCommandExecutor,
    SecretRequests.SecretRequests,
    UsageLimitSources.UsageLimitSources,
  ],
}).annotate(Tool.Destructive, true);

const usageSourceAddHandler = McpToolAccess.writesEnvironment(
  (input: typeof UsageSourceAddTool.parametersSchema.Type, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const add = Effect.gen(function* () {
        const caller = yield* check;
        const context = yield* readCaller();
        const environment = yield* Environment.ServerEnvironment;
        const descriptor = yield* environment.getDescriptor;
        if (descriptor.environmentId !== context.scope.environmentId)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "This credential belongs to another environment.",
          });
        const url = localUsageHubUrl(input.url);
        if (url === undefined || (input.secretRef === undefined) === (input.keyFile === undefined))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Use a loopback IP hub URL and exactly one of secretRef or keyFile.",
          });
        let key: string;
        if (input.secretRef !== undefined) {
          if (caller.caller === undefined)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "Use a secretRef from a thread on this environment, or keyFile on the target server.",
            });
          const requests = yield* SecretRequests.SecretRequests;
          key = yield* requests
            .consume({ ref: input.secretRef, projectId: caller.caller.projectId })
            .pipe(
              Effect.mapError(
                () =>
                  new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: "The secretRef is unavailable or expired.",
                  }),
              ),
            );
        } else if (input.keyFile !== undefined) {
          const path = input.keyFile;
          const platform = yield* HostProcess.Platform;
          const userId = yield* HostProcess.UserId;
          key = yield* Effect.tryPromise({
            try: () => readUsageSourceKey(path, { platform, userId }),
            catch: () =>
              new OrchestratorMcpFailure({
                code: "invalid_request",
                message: `Use a nonempty owner-only regular POSIX key file of at most ${MAX_USAGE_SOURCE_KEY_BYTES} bytes.`,
              }),
          });
        } else
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A key is required.",
          });
        // Secret refs are consumed once, including rejected writes; checking a configured key requires consuming it.
        yield* check;
        const sources = yield* UsageLimitSources.UsageLimitSources;
        return yield* sources
          .add({ url, ...(input.label ? { label: input.label } : {}), managementKey: key })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail }),
            ),
          );
      });
      return yield* scope.thread === undefined
        ? add
        : executor.withLock(scope.thread.threadId, add);
    }),
);

export const UsageSourceToolkit = Toolkit.make(UsageSourceAddTool);
export const usageSourceHandlers = McpToolAccess.toLayer(UsageSourceToolkit, {
  t3_usage_source_add: usageSourceAddHandler,
});

export const registerUsageSource = (register: typeof toolkitRegistration) =>
  register(UsageSourceToolkit, usageSourceHandlers).pipe(
    Layer.provide(ThreadCommandExecutor.layer),
  );
