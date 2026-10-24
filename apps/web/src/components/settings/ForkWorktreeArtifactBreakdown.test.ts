import { describe, expect, it } from "vite-plus/test";
import type { StorageCleanupReport } from "@t3tools/contracts";
import {
  forkArtifactBreakdownText,
  forkArtifactReclamationSummary,
} from "./ForkWorktreeArtifactBreakdown";

const report: StorageCleanupReport = {
  trigger: "manual",
  startedAt: "2026-10-19T00:00:00Z",
  finishedAt: "2026-10-19T00:00:01Z",
  entries: [],
  counts: { removed: 1, kept: 0, failed: 0 },
  omittedCount: 0,
  bytesFreed: 0,
};

describe("artifact reclamation summary", () => {
  it("does not present logical node_modules size or an unknown zero as physical reclamation", () => {
    const summary = forkArtifactReclamationSummary({
      ...report,
      entries: [
        {
          kind: "worktree",
          outcome: "removed",
          reason: "Artifacts removed",
          path: "/checkout",
          projectPath: null,
          threadId: null,
          threadTitle: null,
          bytes: null,
          files: null,
          artifactBreakdown: [
            { folderType: "node_modules", logicalBytes: 6.91 * 1024 ** 3, folders: 1 },
          ],
        },
      ],
    });
    expect(summary).toContain("logical");
    expect(summary).toContain("not measured");
    expect(summary).not.toContain("recovered");
    expect(summary).not.toContain("6.91");
  });
  it("keeps the existing summary for reports without artifact eviction", () => {
    expect(forkArtifactReclamationSummary({ ...report, bytesFreed: 42 })).toBe("42 B recovered.");
  });
  it("separates the breakdown from the reason with one period", () => {
    const breakdown = [{ folderType: "node_modules" as const, logicalBytes: 5, folders: 1 }];
    expect(
      forkArtifactBreakdownText("Artifacts removed; checkout kept", breakdown)?.startsWith(
        ". Logical bytes removed: ",
      ),
    ).toBe(true);
    expect(
      forkArtifactBreakdownText("No rules apply.", breakdown)?.startsWith(
        " Logical bytes removed: ",
      ),
    ).toBe(true);
    expect(forkArtifactBreakdownText("Artifacts removed", [])).toBeNull();
  });
});
