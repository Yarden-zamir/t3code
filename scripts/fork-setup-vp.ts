// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
/* oxlint-disable t3code/no-global-process-runtime -- Worktree setup runs before dependencies are installed. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * The shell-quoted `vp` path for worktree setup. Shells that the desktop app starts often lack
 * the user's PATH, so a bare `vp` exits with 127. The main checkout's own `vp` is the last fallback.
 */
export function forkVpCommand(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  // Windows runs the `vp.cmd` shim through the shell; only POSIX setups hit the missing PATH.
  if (platform === "win32") return "vp";
  const candidates = [
    ...(env.PATH ?? "")
      .split(NodePath.delimiter)
      .filter((dir) => dir !== "")
      .map((dir) => NodePath.join(dir, "vp")),
    ...(env.VP_BIN_DIR ? [NodePath.join(env.VP_BIN_DIR, "vp")] : []),
    NodePath.join(env.HOME ?? NodeOS.homedir(), ".vite-plus", "bin", "vp"),
    NodePath.join(projectRoot, "node_modules", ".bin", "vp"),
  ];
  const found = candidates.find(isExecutable);
  if (found === undefined) {
    throw new Error(
      [
        "vp not found. Install it with `curl -fsSL https://vite.plus | bash`, or run `vp i` in the main checkout.",
        "Searched:",
        ...candidates.map((path) => `  ${path}`),
      ].join("\n"),
    );
  }
  return JSON.stringify(found);
}

function isExecutable(path: string): boolean {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
}
