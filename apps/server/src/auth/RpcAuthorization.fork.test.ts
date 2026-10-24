import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes fork", () => {
  it("requires source control writes to start Fork Sync but not to read the fork changelog", () => {
    expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.forkChangelogStartSync)).toBe(
      AuthSourceControlWriteScope,
    );
    for (const method of [
      WS_METHODS.forkChangelogListReleases,
      WS_METHODS.forkChangelogReleaseChanges,
      WS_METHODS.forkChangelogUpstreamPending,
      WS_METHODS.forkChangelogSyncStatus,
    ]) {
      expect(RpcAuthorization.requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("requires source control writes to prepare the new worktree of a terminal draft", () => {
    expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.vcsPrepareDraftWorktree)).toBe(
      RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.vcsCreateWorktree),
    );
    expect(RpcAuthorization.requiredScopeForRpcMethod(WS_METHODS.vcsPrepareDraftWorktree)).toBe(
      AuthSourceControlWriteScope,
    );
  });
});

const method = WS_METHODS.terminalMoveToThread;
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, typeof method> =>
      tag !== method,
  ),
);

// The move creates a thread, so a connection that can only operate terminals must not use it.
it.effect.each([
  {
    scopes: [AuthOrchestrationReadScope, AuthTerminalOperateScope],
    missing: AuthOrchestrationOperateScope,
  },
  {
    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    missing: AuthTerminalOperateScope,
  },
])("rejects moving a terminal to a thread without $missing", ({ scopes, missing }) =>
  Effect.gen(function* () {
    const handled: Array<string> = [];
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(method, () =>
            Effect.sync(() => handled.push("move")).pipe(Effect.as({})),
          ),
          RpcAuthorization.layer(scopes),
        ),
      ),
    );

    const failure = yield* client[method]({
      threadId: ThreadId.make("thread:source"),
      terminalId: "term-2",
      newThreadId: ThreadId.make("thread:new"),
    }).pipe(Effect.flip);
    expect(failure).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: missing,
    });
    expect(handled).toEqual([]);
  }).pipe(Effect.scoped),
);
