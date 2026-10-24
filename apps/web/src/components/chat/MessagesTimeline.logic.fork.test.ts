import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

const stage = (id: "agent" | "setup-script", status: "done" | "pending") =>
  ({
    id,
    status,
    startedAt: status === "done" ? "2026-01-01T00:00:01Z" : null,
    endedAt: status === "done" ? "2026-01-01T00:00:02Z" : null,
    percent: null,
    detail: null,
    tail: [],
  }) as const;

const doneSetup = (stages: WorktreeSetupSnapshot["stages"]): WorktreeSetupSnapshot => ({
  threadId: ThreadId.make("thread-setup"),
  phase: "done",
  startedAt: "2026-01-01T00:00:00Z",
  endedAt: "2026-01-01T00:00:02Z",
  branch: "t3/abc",
  baseRef: "main",
  worktreePath: "/worktrees/t3-abc",
  setupScript: null,
  stages,
  error: null,
  sequence: 4,
});

const rowKinds = (worktreeSetup: WorktreeSetupSnapshot) =>
  deriveMessagesTimelineRows({
    timelineEntries: [],
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup,
  }).map((row) => row.kind);

it("shows no working row for a finished setup that starts no agent (a terminal draft)", () => {
  expect(rowKinds(doneSetup([stage("setup-script", "done")]))).toEqual(["worktree-setup"]);
});

it("keeps the working row while a finished setup waits for its agent", () => {
  expect(rowKinds(doneSetup([stage("setup-script", "done"), stage("agent", "pending")]))).toEqual([
    "working",
    "worktree-setup",
  ]);
});
