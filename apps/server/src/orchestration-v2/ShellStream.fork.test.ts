import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import {
  ProjectId,
  ProviderInstanceId,
  TERMINAL_THREAD_INSTANCE_ID,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { omitOlderSettledShells } from "./ShellStream.ts";

const DAY = 24 * 60 * 60 * 1000;

const settledRow = (id: string, settledDaysAgo: number, providerInstanceId: ProviderInstanceId) =>
  ({
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-a"),
    providerInstanceId,
    archivedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    status: "completed",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    settledOverride: "settled",
    settledAt: DateTime.makeUnsafe(100 * DAY - settledDaysAgo * DAY),
  }) as unknown as OrchestrationV2ThreadShell;

describe("omitOlderSettledShells (fork terminal threads)", () => {
  it("keeps an older settled terminal thread, whose program can still run, and counts it", () => {
    const codex = ProviderInstanceId.make("codex");
    const newest = Array.from({ length: 25 }, (_, index) =>
      settledRow(`new-${index}`, index / 10, codex),
    );
    const result = omitOlderSettledShells({
      threads: [
        ...newest,
        settledRow("old-agent", 30, codex),
        settledRow("old-shell", 30, TERMINAL_THREAD_INSTANCE_ID),
      ],
      snapshotSequence: 1,
      now: DateTime.makeUnsafe(100 * DAY),
    });
    const ids = result.threads.map((thread) => thread.id);
    expect(ids).toContain("old-shell");
    expect(ids).not.toContain("old-agent");
    // Kept rows still count: clients subtract the older rows that they hold.
    expect(result.olderSettled.counts).toEqual([{ projectId: "project-a", count: 2 }]);
  });
});
