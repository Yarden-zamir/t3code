import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { callingThread } from "./handlers.ts";

const threadScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session",
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
};

const call = (scope: McpInvocationContext.McpInvocationScope) =>
  callingThread("kitshn_publish").pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
  );

it.effect("a kitshn call runs only with the thread's own credential", () =>
  Effect.gen(function* () {
    const authorization = Redacted.make("Bearer thread-token");
    const caller = yield* call({ ...threadScope, threadAuthorization: authorization });
    expect(caller).toEqual({ threadId: "thread-1", authorization });
    expect((yield* Effect.flip(call(threadScope))).code).toBe("capability_denied");
  }),
);
