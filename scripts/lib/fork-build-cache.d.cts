interface WorkspacePaths {
  worktree: string;
  root: string;
  folder: string;
}

export function enabled(): boolean;
export function hashPath(canonicalPath: string): string;
export function workspacePaths(worktree: string, kind: "vite" | "gradle"): WorkspacePaths;
export function viteCacheDir(configUrl: string): string | undefined;
export function androidBuildLink(worktree: string): WorkspacePaths;
export function gradleLeaseScript(paths: WorkspacePaths): string;
export function prune(options?: {
  days?: number;
  dryRun?: boolean;
  log?: (message: string) => void;
}): number;
