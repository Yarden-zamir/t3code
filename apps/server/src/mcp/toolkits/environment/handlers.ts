import { OrchestratorMcpFailure, type ServerSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import { readUsageSourceKey } from "../../../fork/usageSourceKey.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as Settings from "../../../serverSettings.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}

function localHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      });
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
  t3_usage_source_add: McpToolAccess.writesEnvironment(
    (input, check) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const add = Effect.gen(function* () {
          const caller = yield* check;
          yield* access;
          if (
            !localHubUrl(input.url) ||
            (input.secretRef === undefined) === (input.keyFile === undefined)
          ) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Use a loopback IP hub URL and exactly one of secretRef or keyFile.",
            });
          }
          let key: string;
          if (input.secretRef !== undefined) {
            if (caller.caller === undefined) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "A secretRef must be used from a local thread.",
              });
            }
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
          } else {
            const platform = yield* HostProcess.Platform;
            const userId = yield* HostProcess.UserId;
            key = yield* Effect.tryPromise({
              try: () => readUsageSourceKey(input.keyFile!, { platform, userId }),
              catch: () =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message:
                    "The key file must be an absolute, owner-only regular file on a POSIX server.",
                }),
            });
          }
          key = key.trim();
          if (!key || Buffer.byteLength(key, "utf8") > 4096 || /[\r\n\0]/.test(key)) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "The management key is empty or invalid.",
            });
          }
          yield* check;
          const sources = yield* UsageLimitSources.UsageLimitSources;
          return yield* sources
            .add({
              url: input.url,
              ...(input.label ? { label: input.label } : {}),
              managementKey: key,
            })
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
    { linkedCallers: "allowed" },
  ),
});
