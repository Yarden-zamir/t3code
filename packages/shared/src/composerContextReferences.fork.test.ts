import { type ComposerContextId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { unreadableThreadContexts } from "./composerContextReferences.ts";

const ctx = (value: string) => value as ComposerContextId;

describe("unreadableThreadContexts", () => {
  it("treats a thread on a readable peer machine as readable", () => {
    const local = {
      version: 1 as const,
      kind: "thread" as const,
      contextId: ctx("thread_local"),
      label: "Local thread",
      environmentId: EnvironmentId.make("env-local"),
      threadId: ThreadId.make("local"),
      title: "Local thread",
    };
    const peer = {
      ...local,
      contextId: ctx("thread_peer"),
      environmentId: EnvironmentId.make("env-peer"),
      threadId: ThreadId.make("peer"),
    };
    const foreign = {
      ...local,
      contextId: ctx("thread_foreign"),
      environmentId: EnvironmentId.make("env-foreign"),
      threadId: ThreadId.make("foreign"),
    };
    const records = [local, peer, foreign];
    const text =
      "[Local](t3-context://v1/thread/thread_local) [Peer](t3-context://v1/thread/thread_peer) [Foreign](t3-context://v1/thread/thread_foreign)";

    expect(
      unreadableThreadContexts({
        text,
        records,
        readableEnvironmentIds: [local.environmentId, peer.environmentId],
      }),
    ).toEqual([foreign]);
    expect(
      unreadableThreadContexts({ text, records, readableEnvironmentIds: [local.environmentId] }),
    ).toEqual([peer, foreign]);
  });
});
