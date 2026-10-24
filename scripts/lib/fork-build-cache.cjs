const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const enabled = () => process.env.T3_FORK_CENTRAL_BUILD_CACHE === "1";
const cacheHome = () => {
  const folder = path.resolve(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"));
  return fs.existsSync(folder) ? fs.realpathSync(folder) : folder;
};
const hashPath = (canonicalPath) => crypto.createHash("sha256").update(canonicalPath).digest("hex");
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

function inCheckout(folder) {
  for (let current = folder; ; current = path.dirname(current)) {
    if (
      fs.statSync(path.join(current, ".git"), { throwIfNoEntry: false })?.isFile() ||
      fs.existsSync(path.join(current, ".git/HEAD")) ||
      fs.existsSync(path.join(current, "pnpm-workspace.yaml"))
    )
      return true;
    if (path.dirname(current) === current) return false;
  }
}

function workspacePaths(worktree, kind) {
  const canonical = fs.realpathSync(worktree);
  const root = path.join(cacheHome(), kind === "vite" ? "t3-vite" : "t3-gradle/workspaces");
  if (inCheckout(root)) throw new Error("Build cache must be outside the checkout");
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);
  if (inside(canonical, realRoot) || inCheckout(realRoot))
    throw new Error("Build cache must be outside the checkout");
  return { worktree: canonical, root: realRoot, folder: path.join(realRoot, hashPath(canonical)) };
}

// Builds and prune share this short critical section: no build can start between a lock check and removal.
const GATE_WAIT_MS = 5_000;
// Gate operations normally take milliseconds; 30 seconds allows slow disks before recovering a crashed holder.
const GATE_STALE_MS = 30_000;
const gateWait = new Int32Array(new SharedArrayBuffer(4));

function withGate(root, operation) {
  const gate = path.join(root, ".gate");
  const deadline = Date.now() + GATE_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(gate);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - fs.statSync(gate).mtimeMs > GATE_STALE_MS) fs.rmdirSync(gate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out waiting for build cache gate ${gate}. Stop builds using this cache, then remove ${gate} and retry.`,
      );
    Atomics.wait(gateWait, 0, 0, 10);
  }
  try {
    return operation();
  } finally {
    fs.rmdirSync(gate);
  }
}

function writeWorkspace(paths) {
  fs.mkdirSync(paths.folder, { recursive: true });
  fs.writeFileSync(
    path.join(paths.folder, "workspace.json"),
    JSON.stringify({ worktree: paths.worktree }),
  );
}

function touch(folder) {
  fs.writeFileSync(path.join(folder, "last-used"), String(Date.now()));
}

function acquire(paths) {
  const locks = path.join(paths.folder, "locks");
  fs.mkdirSync(locks, { recursive: true });
  const lock = path.join(locks, `${process.pid}-${crypto.randomUUID()}`);
  fs.writeFileSync(lock, "");
  touch(paths.folder);
  return () => {
    touch(paths.folder);
    fs.rmSync(lock, { force: true });
  };
}

// Keep this on cacheDir, not a config spread: vp statically reads task config during filtered installs.
// Callers assert the optional value for exactOptionalPropertyTypes; Vite treats undefined as its default.
function viteCacheDir(configUrl) {
  if (!enabled()) return undefined;
  const { fileURLToPath } = require("node:url");
  const configDir = path.dirname(fileURLToPath(configUrl));
  let worktree = configDir;
  while (!fs.existsSync(path.join(worktree, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(worktree);
    if (parent === worktree) throw new Error("Cannot find workspace root");
    worktree = parent;
  }
  const paths = workspacePaths(worktree, "vite");
  const app =
    path.relative(paths.worktree, fs.realpathSync(configDir)).replaceAll(path.sep, "-") || "root";
  const release = withGate(paths.root, () => {
    writeWorkspace(paths);
    fs.mkdirSync(path.join(paths.folder, app), { recursive: true });
    return acquire(paths);
  });
  // Configs also load in tests and pack. A process lease covers those entry points and dev-server restarts.
  process.once("exit", release);
  return path.join(paths.folder, app);
}

function androidBuildLink(worktree) {
  const paths = workspacePaths(worktree, "gradle");
  const link = path.join(paths.worktree, "apps/mobile/android/app/build");
  return withGate(paths.root, () => {
    writeWorkspace(paths);
    let existing;
    try {
      existing = fs.lstatSync(link);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing) {
      if (!existing.isSymbolicLink())
        throw new Error(
          "Local app/build exists. Run expo prebuild --clean before enabling the central cache.",
        );
      const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
      if (path.dirname(target) !== path.join(paths.folder, "app"))
        throw new Error("Unrecognized app/build link");
      fs.mkdirSync(target, { recursive: true });
      touch(paths.folder);
      return paths;
    }
    const target = path.join(paths.folder, "app", crypto.randomUUID());
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, link, "dir");
    touch(paths.folder);
    return paths;
  });
}

function gradleLeaseScript(paths) {
  const quote = (value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  return `
def forkCacheRoot = new File(${quote(paths.root)})
def forkCacheWorkspace = new File(${quote(paths.folder)})
def forkCacheGate = new File(forkCacheRoot, '.gate')
if (!forkCacheGate.mkdir()) throw new GradleException('Build cache is busy; retry the build')
def forkCacheLock
try {
    new File(forkCacheWorkspace, 'locks').mkdirs()
    new File(forkCacheWorkspace, 'workspace.json').text = ${quote(JSON.stringify({ worktree: paths.worktree }))}
    forkCacheLock = new File(forkCacheWorkspace, 'locks/' + ProcessHandle.current().pid() + '-' + UUID.randomUUID())
    forkCacheLock.text = ''
    gradle.buildFinished {
        new File(forkCacheWorkspace, 'last-used').text = '' + System.currentTimeMillis()
        forkCacheLock.delete()
    }
    new File(forkCacheWorkspace, 'last-used').text = '' + System.currentTimeMillis()
    def output = new File(projectDir, 'build')
    if (!java.nio.file.Files.exists(output.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
        def generation = new File(forkCacheWorkspace, 'app/' + UUID.randomUUID())
        generation.mkdirs()
        java.nio.file.Files.createSymbolicLink(output.toPath(), generation.toPath())
    }
    if (!java.nio.file.Files.isSymbolicLink(output.toPath())) throw new GradleException('Local app/build exists; run expo prebuild --clean')
    def target = java.nio.file.Files.readSymbolicLink(output.toPath()).toFile()
    if (target.parentFile != new File(forkCacheWorkspace, 'app')) throw new GradleException('Unrecognized app/build link')
    target.mkdirs()
} finally {
    forkCacheGate.delete()
}
`;
}

function directory(folder) {
  try {
    return fs.lstatSync(folder).isDirectory();
  } catch {
    return false;
  }
}

function bytes(folder) {
  const stat = fs.lstatSync(folder);
  if (stat.isSymbolicLink()) return 0;
  const allocated = typeof stat.blocks === "number" ? stat.blocks * 512 : stat.size;
  if (!stat.isDirectory()) return allocated;
  return fs
    .readdirSync(folder)
    .reduce((sum, name) => sum + bytes(path.join(folder, name)), allocated);
}

function locked(folder) {
  const locks = path.join(folder, "locks");
  if (!directory(locks)) return fs.existsSync(locks);
  return fs.readdirSync(locks).some((name) => {
    const pid = Number(name.split("-")[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  });
}

function prune({ days = 14, dryRun = false, log = console.log } = {}) {
  if (!Number.isFinite(days) || days < 0) throw new Error("days must be a non-negative number");
  let freed = 0;
  for (const kind of ["vite", "gradle"]) {
    const root = path.join(cacheHome(), kind === "vite" ? "t3-vite" : "t3-gradle/workspaces");
    // Never traverse symlinked ancestors or guess ownership of an unknown folder.
    if (!directory(root) || fs.realpathSync(root) !== root || inCheckout(root)) continue;
    withGate(root, () => {
      for (const name of fs.readdirSync(root)) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        const folder = path.join(root, name);
        if (!directory(folder)) continue;
        let worktree;
        let lastUsed;
        try {
          ({ worktree } = JSON.parse(fs.readFileSync(path.join(folder, "workspace.json"), "utf8")));
          lastUsed = Number(fs.readFileSync(path.join(folder, "last-used"), "utf8"));
        } catch {
          continue;
        }
        if (
          typeof worktree !== "string" ||
          !path.isAbsolute(worktree) ||
          hashPath(worktree) !== name ||
          inside(worktree, root) ||
          !Number.isFinite(lastUsed) ||
          locked(folder)
        )
          continue;
        const missing = !fs.existsSync(worktree);
        const old = Date.now() - lastUsed > days * 86_400_000;
        const remove = (target, reason) => {
          const size = bytes(target);
          log(`${dryRun ? "Would remove" : "Remove"} ${target} (${reason}, ${size} bytes)`);
          if (!dryRun) fs.rmSync(target, { recursive: true });
          freed += size;
        };
        if (kind === "vite") {
          if (missing || old) remove(folder, missing ? "missing worktree" : "inactive");
          continue;
        }
        const app = path.join(folder, "app");
        const link = path.join(worktree, "apps/mobile/android/app/build");
        let current;
        try {
          if (fs.lstatSync(link).isSymbolicLink())
            current = path.resolve(path.dirname(link), fs.readlinkSync(link));
          else continue;
        } catch (error) {
          if (error.code !== "ENOENT") continue;
        }
        if (missing || old || !current) {
          remove(folder, missing ? "missing worktree" : old ? "inactive" : "no current link");
        } else if (directory(app)) {
          for (const generation of fs.readdirSync(app)) {
            const target = path.join(app, generation);
            if (directory(target) && target !== current) remove(target, "superseded generation");
          }
        }
      }
    });
  }
  log(`${dryRun ? "Would free" : "Freed"} ${freed} bytes`);
  return freed;
}

module.exports = {
  enabled,
  hashPath,
  workspacePaths,
  viteCacheDir,
  androidBuildLink,
  gradleLeaseScript,
  prune,
};
