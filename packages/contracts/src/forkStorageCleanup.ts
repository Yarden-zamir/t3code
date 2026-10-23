import * as Schema from "effect/Schema";

export const FORK_ARTIFACT_FOLDER_TYPES = [
  "android-build",
  "gradle-cache",
  "build-output",
  "cache",
  "node_modules",
] as const;
const FolderType = Schema.Literals(FORK_ARTIFACT_FOLDER_TYPES);
export type ForkArtifactFolderType = typeof FolderType.Type;

const ArtifactBreakdown = Schema.Array(
  Schema.Struct({
    folderType: FolderType,
    logicalBytes: Schema.Number,
    folders: Schema.Number,
  }),
);
export type ForkArtifactBreakdown = typeof ArtifactBreakdown.Type;

export const ForkStorageCleanupReportEntryFields = {
  artifactBreakdown: Schema.optionalKey(ArtifactBreakdown),
};
