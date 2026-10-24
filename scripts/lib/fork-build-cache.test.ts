// @effect-diagnostics nodeBuiltinImport:off globalDate:off - exercises the dependency-free build tooling filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveConfig } from "vite-plus";
import cache from "./fork-build-cache.cjs";

let temp: string;
let worktree: string;
const quiet = () => {};

beforeEach(() => {
  temp = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-cache-test-")),
  );
  worktree = NodePath.join(temp, "checkout");
  NodeFS.mkdirSync(NodePath.join(worktree, "apps/mobile/android/app"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(worktree, "pnpm-workspace.yaml"), "packages: []");
  vi.stubEnv("XDG_CACHE_HOME", NodePath.join(temp, "cache"));
  vi.stubEnv("T3_FORK_CENTRAL_BUILD_CACHE", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  NodeFS.rmSync(temp, { recursive: true, force: true });
});

function record(kind: "vite" | "gradle" = "vite", age = 0) {
  const paths = cache.workspacePaths(worktree, kind);
  NodeFS.mkdirSync(paths.folder, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(paths.folder, "workspace.json"),
    JSON.stringify({ worktree: paths.worktree }),
  );
  // The new folder's mtime stands in for now: prune compares real file times with the real clock.
  const now = NodeFS.statSync(paths.folder).mtimeMs;
  NodeFS.writeFileSync(NodePath.join(paths.folder, "last-used"), String(now - age * 86_400_000));
  NodeFS.writeFileSync(NodePath.join(paths.folder, "payload"), Buffer.alloc(8192));
  return paths;
}

describe("central build cache", () => {
  it("hashes canonical checkout paths, not aliases, and separates checkouts", () => {
    const alias = NodePath.join(temp, "alias");
    NodeFS.symlinkSync(worktree, alias, "junction");
    expect(cache.workspacePaths(alias, "vite").folder).toBe(
      cache.workspacePaths(worktree, "vite").folder,
    );
    const other = NodePath.join(temp, "other");
    NodeFS.mkdirSync(other);
    expect(cache.workspacePaths(other, "vite").folder).not.toBe(
      cache.workspacePaths(worktree, "vite").folder,
    );
    expect(cache.hashPath(worktree)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([undefined, "0"])("leaves Vite defaults unchanged with opt-in %s", async (value) => {
    vi.stubEnv("T3_FORK_CENTRAL_BUILD_CACHE", value);
    const cacheDir = cache.viteCacheDir(
      NodeURL.pathToFileURL(NodePath.join(worktree, "vite.config.ts")).href,
    );
    expect(cacheDir).toBeUndefined();
    const defaults = await resolveConfig({ configFile: false, root: worktree }, "build");
    const configured = await resolveConfig(
      { configFile: false, root: worktree, cacheDir: cacheDir! },
      "build",
    );
    expect(configured.cacheDir).toBe(defaults.cacheDir);
    expect(NodeFS.existsSync(NodePath.join(temp, "cache"))).toBe(false);
  });

  it("creates separate Vite app folders and releases the build lease on exit", () => {
    const config = NodeURL.pathToFileURL(NodePath.join(worktree, "vite.config.ts")).href;
    const mobile = NodeURL.pathToFileURL(
      NodePath.join(worktree, "apps/mobile/vite.config.ts"),
    ).href;
    const helper = NodeURL.fileURLToPath(new URL("./fork-build-cache.cjs", import.meta.url));
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "-e",
        `const cache = require(process.argv[1]); console.log(cache.viteCacheDir(process.argv[2])); console.log(cache.viteCacheDir(process.argv[3]));`,
        helper,
        config,
        mobile,
      ],
      { encoding: "utf8" },
    );
    const paths = cache.workspacePaths(worktree, "vite");
    expect(output.trim().split("\n")).toEqual([
      NodePath.join(paths.folder, "root"),
      NodePath.join(paths.folder, "apps-mobile"),
    ]);
    expect(NodeFS.existsSync(NodePath.join(paths.folder, "root"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(paths.folder, "apps-mobile"))).toBe(true);
    expect(NodeFS.readdirSync(NodePath.join(paths.folder, "locks"))).toEqual([]);
    expect(cache.prune({ days: 0, log: quiet })).toBeGreaterThan(0);
  });

  it("refuses a cache inside the checkout", () => {
    vi.stubEnv("XDG_CACHE_HOME", NodePath.join(worktree, "cache"));
    expect(() => cache.workspacePaths(worktree, "vite")).toThrow("outside the checkout");
  });

  it.each(["vite", "gradle"] as const)("allows a %s cache below a stray .git folder", (kind) => {
    const home = NodePath.join(temp, "home");
    NodeFS.mkdirSync(NodePath.join(home, ".git/info"), { recursive: true });
    vi.stubEnv("XDG_CACHE_HOME", NodePath.join(home, ".cache"));
    const paths = kind === "gradle" ? cache.androidBuildLink(worktree) : record(kind, 30);
    expect(paths.root.startsWith(NodePath.join(home, ".cache") + NodePath.sep)).toBe(true);
    if (kind === "gradle") {
      const link = NodePath.join(worktree, "apps/mobile/android/app/build");
      expect(NodeFS.readlinkSync(link).startsWith(paths.folder + NodePath.sep)).toBe(true);
      NodeFS.writeFileSync(NodePath.join(paths.folder, "last-used"), "0");
    }
    expect(cache.prune({ log: quiet })).toBeGreaterThan(0);
    expect(NodeFS.existsSync(paths.folder)).toBe(false);
  });

  it.each(["vite", "gradle"] as const)("refuses a %s cache below a real Git repository", (kind) => {
    const paths = record(kind, 30);
    NodeChildProcess.execFileSync("git", ["init", "--quiet", temp], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(() => cache.workspacePaths(worktree, kind)).toThrow("outside the checkout");
    if (kind === "gradle") {
      expect(() => cache.androidBuildLink(worktree)).toThrow("outside the checkout");
    }
    expect(cache.prune({ log: quiet })).toBe(0);
    expect(NodeFS.existsSync(paths.folder)).toBe(true);
  });

  it("will not create or prune a cache inside a different checkout", () => {
    const paths = record("vite", 30);
    const other = NodePath.join(temp, "other-checkout");
    NodeFS.mkdirSync(other);
    NodeFS.writeFileSync(NodePath.join(other, ".git"), "gitdir: unused");
    NodeFS.renameSync(NodePath.join(temp, "cache"), NodePath.join(other, "cache"));
    vi.stubEnv("XDG_CACHE_HOME", NodePath.join(other, "cache"));
    expect(() => cache.workspacePaths(worktree, "vite")).toThrow("outside the checkout");
    expect(cache.prune({ log: quiet })).toBe(0);
    expect(
      NodeFS.existsSync(
        NodePath.join(other, "cache/t3-vite", NodePath.basename(paths.folder), "payload"),
      ),
    ).toBe(true);
  });

  it("uses the same central cache through an XDG base alias", () => {
    const paths = record("vite", 30);
    const alias = NodePath.join(temp, "cache-alias");
    NodeFS.symlinkSync(NodePath.join(temp, "cache"), alias, "junction");
    vi.stubEnv("XDG_CACHE_HOME", alias);
    expect(cache.workspacePaths(worktree, "vite").folder).toBe(paths.folder);
    expect(cache.prune({ log: quiet })).toBeGreaterThan(0);
    expect(NodeFS.existsSync(paths.folder)).toBe(false);
  });

  it("preserves a current generation and drops a superseded one after a clean", () => {
    const paths = cache.androidBuildLink(worktree);
    const link = NodePath.join(worktree, "apps/mobile/android/app/build");
    const first = NodeFS.readlinkSync(link);
    cache.androidBuildLink(worktree);
    expect(NodeFS.readlinkSync(link)).toBe(first);
    NodeFS.unlinkSync(link);
    cache.androidBuildLink(worktree);
    const second = NodeFS.readlinkSync(link);
    expect(second).not.toBe(first);
    cache.prune({ log: quiet });
    expect(NodeFS.existsSync(first)).toBe(false);
    expect(NodeFS.existsSync(second)).toBe(true);
    expect(NodeFS.existsSync(paths.folder)).toBe(true);
  });

  it("does not migrate or remove an existing app build directory", () => {
    const build = NodePath.join(worktree, "apps/mobile/android/app/build");
    NodeFS.mkdirSync(build);
    NodeFS.writeFileSync(NodePath.join(build, "keep"), "source");
    expect(() => cache.androidBuildLink(worktree)).toThrow("prebuild --clean");
    expect(NodeFS.readFileSync(NodePath.join(build, "keep"), "utf8")).toBe("source");
  });

  it("protects an old folder with a running build lock", () => {
    const paths = record("vite", 30);
    NodeFS.mkdirSync(NodePath.join(paths.folder, "locks"));
    NodeFS.writeFileSync(NodePath.join(paths.folder, "locks", `${process.pid}-test`), "");
    expect(cache.prune({ log: quiet })).toBe(0);
    expect(NodeFS.existsSync(paths.folder)).toBe(true);
  });

  it("dry-runs then removes an old cache, never follows a payload symlink", () => {
    const paths = record("vite", 30);
    const keep = NodePath.join(worktree, "keep");
    NodeFS.writeFileSync(keep, "source");
    NodeFS.symlinkSync(worktree, NodePath.join(paths.folder, "checkout"), "junction");
    const planned = cache.prune({ dryRun: true, log: quiet });
    expect(planned).toBeGreaterThan(0);
    expect(NodeFS.existsSync(paths.folder)).toBe(true);
    expect(cache.prune({ log: quiet })).toBe(planned);
    expect(NodeFS.readFileSync(keep, "utf8")).toBe("source");
  });

  it("removes a recent cache for a missing worktree", () => {
    const paths = record();
    NodeFS.renameSync(worktree, NodePath.join(temp, "moved"));
    expect(cache.prune({ log: quiet })).toBeGreaterThan(0);
    expect(NodeFS.existsSync(paths.folder)).toBe(false);
  });

  it("expires an idle Android workspace without unlinking anything in the checkout", () => {
    const paths = cache.androidBuildLink(worktree);
    const link = NodePath.join(worktree, "apps/mobile/android/app/build");
    const target = NodeFS.readlinkSync(link);
    NodeFS.writeFileSync(NodePath.join(paths.folder, "last-used"), "0");
    cache.prune({ log: quiet });
    expect(NodeFS.readlinkSync(link)).toBe(target);
    expect(NodeFS.existsSync(target)).toBe(false);
    cache.androidBuildLink(worktree);
    expect(NodeFS.existsSync(target)).toBe(true);
  });

  it("keeps unknown locks even when they look stale", () => {
    const paths = record("vite", 30);
    NodeFS.mkdirSync(NodePath.join(paths.folder, "locks"));
    NodeFS.writeFileSync(NodePath.join(paths.folder, "locks", "unknown"), "");
    expect(cache.prune({ log: quiet })).toBe(0);
  });

  it("does not traverse a symlinked workspace or root", () => {
    const paths = record("vite", 30);
    NodeFS.renameSync(paths.folder, NodePath.join(temp, "outside"));
    NodeFS.symlinkSync(NodePath.join(temp, "outside"), paths.folder, "junction");
    expect(cache.prune({ log: quiet })).toBe(0);
    NodeFS.unlinkSync(paths.folder);
    NodeFS.renameSync(paths.root, NodePath.join(temp, "outside-root"));
    NodeFS.symlinkSync(NodePath.join(temp, "outside-root"), paths.root, "junction");
    expect(cache.prune({ log: quiet })).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(temp, "outside/payload"))).toBe(true);
  });

  it("waits for another process to release the gate before pruning", async () => {
    const paths = record("vite", 30);
    const gate = NodePath.join(paths.root, ".gate");
    const holder = NodeChildProcess.spawn(process.execPath, [
      "-e",
      `const fs = require('node:fs');
       fs.mkdirSync(process.argv[1]);
       process.stdout.write('ready');
       setTimeout(() => fs.rmdirSync(process.argv[1]), 100);`,
      gate,
    ]);
    const finished = new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Gate holder exited with code ${code}`));
      });
    });
    await Promise.race([
      new Promise<void>((resolve) => holder.stdout.once("data", () => resolve())),
      finished.then(() => {
        throw new Error("Gate holder exited before taking the gate");
      }),
    ]);
    try {
      expect(cache.prune({ log: quiet })).toBeGreaterThan(0);
      expect(NodeFS.existsSync(paths.folder)).toBe(false);
      expect(NodeFS.existsSync(gate)).toBe(false);
    } finally {
      await finished;
    }
  });

  it("recovers a stale gate left by a crashed process", () => {
    const paths = record("vite", 30);
    const gate = NodePath.join(paths.root, ".gate");
    NodeFS.mkdirSync(gate);
    const old = new Date(NodeFS.statSync(gate).mtimeMs - 60_000);
    NodeFS.utimesSync(gate, old, old);
    expect(cache.prune({ log: quiet })).toBeGreaterThan(0);
    expect(NodeFS.existsSync(paths.folder)).toBe(false);
    expect(NodeFS.existsSync(gate)).toBe(false);
  });

  it("reports the gate path and recovery steps when the wait expires", () => {
    const paths = record("vite", 30);
    const gate = NodePath.join(paths.root, ".gate");
    NodeFS.mkdirSync(gate);
    const now = NodeFS.statSync(gate).mtimeMs;
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 5_000);
    try {
      expect(() => cache.prune({ log: quiet })).toThrow(
        `Timed out waiting for build cache gate ${gate}. Stop builds using this cache, then remove ${gate} and retry.`,
      );
    } finally {
      clock.mockRestore();
    }
    expect(NodeFS.existsSync(paths.folder)).toBe(true);
    expect(NodeFS.existsSync(gate)).toBe(true);
  });
});
