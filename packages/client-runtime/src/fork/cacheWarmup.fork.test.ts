import { RuntimeRequestId, TERMINAL_THREAD_INSTANCE_ID, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import {
  CACHE_WARMUP_MAX_THREADS,
  CACHE_WARMUP_NEWEST_THREADS,
  selectCacheWarmupThreads,
} from "./cacheWarmup.ts";

const at = (ms: number) => DateTime.makeUnsafe(ms);

/** Thread `n` changed at `n` seconds, so a higher number is newer. */
const thread = (n: number, fields: Partial<typeof v2ThreadShell> = {}) => ({
  ...v2ThreadShell,
  id: ThreadId.make(`thread-${n}`),
  updatedAt: at(n * 1_000),
  archivedAt: null,
  deletedAt: null,
  activeRunId: null,
  pendingRuntimeRequest: null,
  ...fields,
});

const ids = (...numbers: ReadonlyArray<number>) => numbers.map((n) => `thread-${n}`);

describe("selectCacheWarmupThreads", () => {
  it("takes unread and waiting threads first, then the newest, and only threads the cache can save", () => {
    const threads = [
      thread(1),
      thread(2, { latestRunCompletedAt: at(2_000), lastVisitedAt: at(1_000) }),
      thread(3, { activityRunStatus: "waiting" }),
      thread(4, {
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("approval"),
          kind: "user_input",
          createdAt: at(4_000),
        },
      }),
      thread(40, { activityRunStatus: "running" }),
      thread(41, { activityRunStatus: "starting" }),
      ...Array.from({ length: CACHE_WARMUP_NEWEST_THREADS }, (_, index) => thread(10 + index)),
      thread(30, { archivedAt: at(30_000) }),
      thread(31, { deletedAt: at(31_000) }),
      thread(32, { providerInstanceId: TERMINAL_THREAD_INSTANCE_ID }),
    ];

    expect(selectCacheWarmupThreads(threads, new Map())).toEqual(
      ids(4, 3, 2, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10),
    );
  });

  it("skips a thread whose cache was saved after its last change", () => {
    const threads = [thread(1), thread(2), thread(3)];
    const savedAt = new Map([
      ["thread-3", 3_000],
      ["thread-2", 1_999],
    ]);

    expect(selectCacheWarmupThreads(threads, savedAt)).toEqual(ids(2, 1));
  });

  it("keeps at most the cap, even with more unread threads", () => {
    const threads = Array.from({ length: CACHE_WARMUP_MAX_THREADS + 5 }, (_, index) =>
      thread(index + 1, { latestRunCompletedAt: at(100_000), lastVisitedAt: at(0) }),
    );

    const selected = selectCacheWarmupThreads(threads, new Map());

    expect(selected).toHaveLength(CACHE_WARMUP_MAX_THREADS);
    expect(selected[0]).toBe(`thread-${CACHE_WARMUP_MAX_THREADS + 5}`);
  });
});
