import {
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("RPC authorization scopes fork", () => {
  it("requires source control writes to start Fork Sync but not to read the fork changelog", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.forkChangelogStartSync)).toBe(
      AuthSourceControlWriteScope,
    );
    for (const method of [
      WS_METHODS.forkChangelogListReleases,
      WS_METHODS.forkChangelogReleaseChanges,
      WS_METHODS.forkChangelogUpstreamPending,
      WS_METHODS.forkChangelogSyncStatus,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });
});
