import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { StorageCleanupReportEntry } from "./settings.ts";
const decodeEntry = Schema.decodeSync(StorageCleanupReportEntry);
const encodeEntry = Schema.encodeSync(StorageCleanupReportEntry);

const legacyEntry = {
  kind: "worktree" as const,
  outcome: "removed" as const,
  reason: "Artifacts removed; checkout kept",
  path: "/worktree",
  threadId: null,
  threadTitle: "Test",
  bytes: 12,
  files: null,
};

describe("fork storage cleanup reports", () => {
  it("keeps legacy reports readable", () => {
    expect(decodeEntry(legacyEntry).artifactBreakdown).toBeUndefined();
  });

  it("preserves per-folder logical byte counts across the wire", () => {
    const entry = {
      ...legacyEntry,
      projectPath: null,
      artifactBreakdown: [
        { folderType: "android-build" as const, logicalBytes: 7, folders: 1 },
        { folderType: "node_modules" as const, logicalBytes: 5, folders: 2 },
      ],
    };
    const encoded = encodeEntry(entry);
    expect(decodeEntry(encoded)).toEqual(entry);
  });
});
