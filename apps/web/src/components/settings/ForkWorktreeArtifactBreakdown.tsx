import type {
  ForkArtifactFolderType,
  StorageCleanupReportEntry,
  StorageCleanupReport,
} from "@t3tools/contracts";
import { formatBytes } from "../../lib/formatBytes";

const labels: Record<ForkArtifactFolderType, string> = {
  "android-build": "Android builds",
  "gradle-cache": "Gradle caches",
  "build-output": "Other builds",
  cache: "Other caches",
  node_modules: "node_modules",
};

export function forkArtifactReclamationSummary(report: StorageCleanupReport) {
  if (report.entries.some((entry) => entry.artifactBreakdown !== undefined))
    return report.bytesFreed > 0
      ? `Other cleanup reported ${formatBytes(report.bytesFreed)}; physical artifact reclamation was not measured.`
      : "Artifact sizes are logical; physical reclamation was not measured.";
  return `${formatBytes(report.bytesFreed)} recovered.`;
}

/** The sentence that follows a cleanup reason, which may or may not end with a period. */
export function forkArtifactBreakdownText(
  reason: string,
  breakdown: StorageCleanupReportEntry["artifactBreakdown"],
): string | null {
  if (!breakdown?.length) return null;
  const folders = breakdown
    .map(
      (entry) =>
        `${labels[entry.folderType]}: ${formatBytes(entry.logicalBytes)} (${entry.folders} ${entry.folders === 1 ? "folder" : "folders"})`,
    )
    .join("; ");
  return `${reason.trimEnd().endsWith(".") ? " " : ". "}Logical bytes removed: ${folders}. Shared filesystem blocks can make physical space reclaimed much smaller.`;
}

export function ForkWorktreeArtifactBreakdown({
  reason,
  breakdown,
}: {
  reason: string;
  breakdown: StorageCleanupReportEntry["artifactBreakdown"];
}) {
  const text = forkArtifactBreakdownText(reason, breakdown);
  return text === null ? null : <span>{text}</span>;
}
