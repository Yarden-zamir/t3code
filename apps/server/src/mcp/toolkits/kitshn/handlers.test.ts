import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { actAsThread } from "../../../fork/forkWorktreeHandoffTool.ts";
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

it.effect("a kitshn call runs only with the calling thread's own credential", () =>
  Effect.gen(function* () {
    const authorization = Redacted.make("Bearer thread-token");
    const caller = yield* call({
      ...threadScope,
      thread: { ...threadScope.thread!, authorization },
    });
    expect(caller).toEqual({ threadId: "thread-1", authorization });
    expect((yield* Effect.flip(call(threadScope))).code).toBe("capability_denied");
    // A scope rebuilt for another thread does not keep the first thread's credential.
    const other = actAsThread(
      { ...threadScope, thread: { ...threadScope.thread!, authorization } },
      { threadId: ThreadId.make("thread-2"), providerInstanceId: ProviderInstanceId.make("codex") },
    );
    expect((yield* Effect.flip(call(other))).code).toBe("capability_denied");
  }),
);
