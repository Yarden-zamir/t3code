import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type StorageCleanupReportEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Settings from "../serverSettings.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import { storageCleanupActivityAt, storageCleanupThreadIdle } from "../storageCleanup.ts";
import * as Artifacts from "./ForkWorktreeArtifacts.ts";
import * as Processes from "./ForkProcessCwds.ts";
import { makeSetupMarker } from "./forkWorktreeSetup.ts";
import { kotlinCacheInventory } from "./fixtures/kotlinCacheInventory.ts";
import * as SetupTracker from "../project/WorktreeSetupTracker.ts";

const layerGit = Git.layer.pipe(
  Layer.provideMerge(SetupTracker.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "fork-worktree-artifacts-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const temporary = yield* fs.makeTempDirectoryScoped();
  const home = path.join(temporary, "home");
  const root = path.join(home, "Github", "t3code");
  yield* fs.makeDirectory(root, { recursive: true });
  const repo = path.join(root, "repo");
  const cwd = path.join(root, "checkout");
  yield* fs.makeDirectory(repo);
  const exec = (args: readonly string[], location = repo) =>
    git.execute({ cwd: location, args, operation: "artifact test" });
  yield* exec(["init", "-b", "main"]);
  yield* exec(["config", "user.name", "Test"]);
  yield* exec(["config", "user.email", "test@example.com"]);
  yield* fs.writeFileString(
    path.join(repo, ".gitignore"),
    "node_modules\nbuild\n.env\nunknown\nignored.txt\n.turbo\n.gradle\n.cxx\napps/mobile/android\napps/*/dist\ndist-electron\nrelease/\nrelease-mock/\n",
  );
  yield* fs.writeFileString(path.join(repo, "source.ts"), "original");
  yield* fs.writeFileString(path.join(repo, "package.json"), "{}");
  yield* fs.writeFileString(path.join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  yield* fs.makeDirectory(path.join(repo, "apps/web"), { recursive: true });
  yield* fs.writeFileString(path.join(repo, "apps/web/package.json"), "{}");
  yield* exec(["add", "."]);
  yield* exec(["commit", "-m", "initial"]);
  yield* exec(["worktree", "add", "-b", "saved", cwd]);
  const file = (relative: string, content = "artifact") =>
    fs
      .makeDirectory(path.dirname(path.join(cwd, relative)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(cwd, relative), content)));
  let cwds: readonly string[] | null = [];
  let processRead = Effect.sync(() => cwds);
  const layer = Artifacts.layer.pipe(
    Layer.provide(
      Layer.succeed(Processes.ForkProcessCwds, { read: Effect.suspend(() => processRead) }),
    ),
  );
  const evict = (reason: string | null = null) =>
    Effect.gen(function* () {
      return yield* (yield* Artifacts.ForkWorktreeArtifacts).evict({
        cwd,
        blocked: Effect.succeed(reason),
      });
    }).pipe(Effect.provide(layer));
  return {
    fs,
    path,
    root,
    home,
    repo,
    cwd,
    file,
    exec,
    evict,
    layer,
    processes: (value: readonly string[] | null) => {
      cwds = value;
      processRead = Effect.sync(() => cwds);
    },
    processRead: (read: Effect.Effect<readonly string[] | null>) => {
      processRead = read;
    },
  };
});

it.effect(
  "removes only ignored, untracked allowlisted directories, preserving all code state",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.file("node_modules/.modules.yaml", "12345");
      yield* f.file("apps/web/node_modules/.modules.yaml", "abc");
      yield* f.file(".env", "secret");
      yield* f.file("unknown/data", "keep ignored data");
      yield* f.file("ignored.txt", "keep ignored file");
      yield* f.file("source.ts", "dirty source");
      const head = (yield* f.exec(["rev-parse", "HEAD"], f.cwd)).stdout;
      const before = (yield* f.exec(["status", "--porcelain=v1", "-z"], f.cwd)).stdout;
      const result = yield* f.evict();
      assert.strictEqual(result.directories, 2);
      assert.strictEqual(result.logicalBytes, 8);
      assert.deepStrictEqual(result.artifactBreakdown, [
        { folderType: "node_modules", logicalBytes: 8, folders: 2 },
      ]);
      assert.include(result.reason, "Artifacts removed");
      assert.isFalse(yield* f.fs.exists(f.path.join(f.cwd, "node_modules")));
      assert.strictEqual(yield* f.fs.readFileString(f.path.join(f.cwd, ".env")), "secret");
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.cwd, "unknown/data")),
        "keep ignored data",
      );
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.cwd, "ignored.txt")),
        "keep ignored file",
      );
      assert.strictEqual(
        (yield* f.exec(["symbolic-ref", "--short", "HEAD"], f.cwd)).stdout.trim(),
        "saved",
      );
      assert.strictEqual(
        yield* f.fs.readFileString(f.path.join(f.cwd, "source.ts")),
        "dirty source",
      );
      assert.strictEqual((yield* f.exec(["rev-parse", "HEAD"], f.cwd)).stdout, head);
      assert.strictEqual((yield* f.exec(["status", "--porcelain=v1", "-z"], f.cwd)).stdout, before);
      const marker = yield* (yield* makeSetupMarker)(f.cwd);
      assert.isTrue(yield* marker.pending);
    }).pipe(Effect.provide(layerGit)),
);

it.effect("keeps tracked files, non-ignored directories and protected nested files", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("node_modules/tracked", "tracked");
    yield* f.exec(["add", "-f", "node_modules/tracked"], f.cwd);
    yield* f.file(".vite/output", "not ignored");
    yield* f.file("apps/mobile/android/app/build/.env", "secret");
    yield* f.file("apps/mobile/android/app/build/outputs/app.apk", "generated");
    const result = yield* f.evict();
    assert.strictEqual(result.directories, 0);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/tracked")));
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, ".vite/output")));
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "apps/mobile/android/app/build/.env")));
    assert.isTrue(
      yield* f.fs.exists(f.path.join(f.cwd, "apps/mobile/android/app/build/outputs/app.apk")),
    );
  }).pipe(Effect.provide(layerGit)),
);

it.effect("never follows symbolic links outside the checkout", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const outside = f.path.join(f.root, "outside");
    yield* f.fs.makeDirectory(outside);
    yield* f.fs.writeFileString(f.path.join(outside, "keep"), "private");
    yield* f.fs.symlink(outside, f.path.join(f.cwd, "node_modules"));
    yield* f.file(".turbo/cache.json", "generated");
    yield* f.fs.symlink(outside, f.path.join(f.cwd, ".turbo/link"));
    const result = yield* f.evict();
    assert.strictEqual(result.directories, 0);
    assert.include(result.reason, "symbolic link");
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, ".turbo/cache.json")));
    assert.strictEqual(yield* f.fs.readFileString(f.path.join(outside, "keep")), "private");
    assert.strictEqual(yield* f.fs.readLink(f.path.join(f.cwd, "node_modules")), outside);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("a process cwd inside the worktree blocks eviction", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("node_modules/.modules.yaml");
    f.processes([f.path.join(f.cwd, "node_modules")]);
    assert.strictEqual((yield* f.evict()).directories, 0);
    f.processes([]);
    assert.strictEqual((yield* f.evict("open terminal")).directories, 0);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/.modules.yaml")));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("a process cwd equal to the container blocks eviction", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("node_modules/.modules.yaml");
    f.processes([f.root]);
    assert.strictEqual((yield* f.evict()).directories, 0);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/.modules.yaml")));
    const marker = yield* (yield* makeSetupMarker)(f.cwd);
    assert.isFalse(yield* marker.pending);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("root and HOME ancestor cwd values above the container do not block", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("node_modules/.modules.yaml");
    f.processes([f.path.parse(f.cwd).root, f.home, f.path.dirname(f.root)]);
    assert.strictEqual((yield* f.evict()).directories, 1);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("recognizes installed dependency payloads without following their internal links", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const pkg = "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg";
    yield* f.file(`${pkg}/package.json`, '{"name":"pkg","version":"1.0.0"}');
    yield* f.file(`${pkg}/index.js`, "module.exports = 1");
    yield* f.file(`${pkg}/README.md`, "package documentation");
    yield* f.file(
      "node_modules/.bin/tool",
      '#!/bin/sh\nbasedir="$(dirname "$0")"\nexec node "$basedir/../pkg/index.js"\n',
    );
    yield* f.fs.symlink(f.path.join(f.cwd, pkg), f.path.join(f.cwd, "node_modules/pkg"));
    assert.strictEqual((yield* f.evict()).directories, 1);
    assert.isFalse(yield* f.fs.exists(f.path.join(f.cwd, "node_modules")));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("an incomplete process scan or unreadable cwd keeps all artifacts", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("node_modules/.modules.yaml");
    f.processes(null);
    assert.include((yield* f.evict()).reason, "could not be inspected");
    f.processes([f.path.join(f.root, "unreadable")]);
    assert.include((yield* f.evict()).reason, "could not be read");
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/.modules.yaml")));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("does not target arbitrary build, dist or non-workspace node_modules directories", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (const relative of [
      "src/build/output.js",
      "apps/unlisted/dist/output.js",
      "apps/web/src/node_modules/.modules.yaml",
    ])
      yield* f.file(relative);
    const result = yield* f.evict();
    assert.strictEqual(result.directories, 0);
    for (const relative of [
      "src/build/output.js",
      "apps/unlisted/dist/output.js",
      "apps/web/src/node_modules/.modules.yaml",
    ])
      assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, relative)));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("unknown source, notes and shared links keep the entire allowlisted folder", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const build = "apps/mobile/android/app/build";
    yield* f.file(`${build}/outputs/app.apk`);
    yield* f.file(`${build}/notes.md`, "keep my notes");
    assert.include((yield* f.evict()).reason, "unrecognized file type");
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, build, "outputs/app.apk")));
    yield* f.fs.remove(f.path.join(f.cwd, build, "notes.md"));
    yield* f.file(`${build}/source.ts`, "keep source");
    assert.strictEqual((yield* f.evict()).directories, 0);
    yield* f.fs.remove(f.path.join(f.cwd, build, "source.ts"));
    yield* f.fs.symlink(f.root, f.path.join(f.cwd, build, "_shared"));
    assert.include((yield* f.evict()).reason, "protected");
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, build, "outputs/app.apk")));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("build-only eviction leaves no dependency-setup marker or claimed reclaimed bytes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("apps/mobile/android/app/build/outputs/app.apk", "apk");
    const result = yield* f.evict();
    assert.deepStrictEqual(result.artifactBreakdown, [
      { folderType: "android-build", logicalBytes: 3, folders: 1 },
    ]);
    const marker = yield* (yield* makeSetupMarker)(f.cwd);
    assert.isFalse(yield* marker.pending);
    assert.notProperty(result, "bytes");
  }).pipe(Effect.provide(layerGit)),
);

it.effect.each([".env.local", "credentials.json", "private.pem", "userdata/state.sqlite"])(
  "a protected %s keeps the whole build folder",
  (file) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const build = "apps/mobile/android/app/build";
      yield* f.file(`${build}/outputs/app.apk`);
      yield* f.file(`${build}/${file}`, "private");
      const result = yield* f.evict();
      assert.strictEqual(result.directories, 0);
      assert.include(result.reason, "protected");
      assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, build, "outputs/app.apk")));
      assert.strictEqual(yield* f.fs.readFileString(f.path.join(f.cwd, build, file)), "private");
    }).pipe(Effect.provide(layerGit)),
);

it.effect("a process appearing at the final guard wins over deletion", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("node_modules/.modules.yaml");
    let reads = 0;
    f.processRead(Effect.sync(() => (++reads >= 3 ? [f.root] : [])));
    assert.strictEqual((yield* f.evict()).directories, 0);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/.modules.yaml")));
    const marker = yield* (yield* makeSetupMarker)(f.cwd);
    assert.isFalse(yield* marker.pending);
  }).pipe(Effect.provide(layerGit)),
);

it.effect("rescans protected contents and Git tracking immediately before deletion", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const output = "apps/mobile/android/app/build/outputs/app.apk";
    yield* f.file(output);
    let reads = 0;
    f.processRead(
      Effect.gen(function* () {
        if (++reads === 2)
          yield* f.file("apps/mobile/android/app/build/.env", "late secret").pipe(Effect.orDie);
        return [];
      }),
    );
    assert.include((yield* f.evict()).reason, "protected");
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, output)));
    yield* f.fs.remove(f.path.join(f.cwd, "apps/mobile/android/app/build/.env"));
    reads = 0;
    f.processRead(
      Effect.gen(function* () {
        if (++reads === 2) yield* f.exec(["add", "-f", output], f.cwd).pipe(Effect.orDie);
        return [];
      }),
    );
    assert.strictEqual((yield* f.evict()).directories, 0);
    assert.include((yield* f.exec(["ls-files", "--", output], f.cwd)).stdout, output);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, output)));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("checks ownership again after scanning and before deletion", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("node_modules/.modules.yaml");
    let reads = 0;
    const result = yield* Effect.gen(function* () {
      return yield* (yield* Artifacts.ForkWorktreeArtifacts).evict({
        cwd: f.cwd,
        blocked: Effect.sync(() => (++reads > 1 ? "a turn was queued" : null)),
      });
    }).pipe(Effect.provide(f.layer));
    assert.strictEqual(result.directories, 0);
    assert.include(result.reason, "turn was queued");
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/.modules.yaml")));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("limits Gradle removal to known mobile artifact paths", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("apps/mobile/android/.gradle/8.14/fileHashes/fileHashes.bin");
    yield* f.file("apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk");
    yield* f.file("apps/mobile/android/app/src/keep.java", "source");
    yield* f.file("apps/mobile/modules/t3-terminal/android/build/outputs/module.aar");
    yield* f.file("apps/mobile/modules/t3-terminal/android/.gradle/8.14/fileHashes/fileHashes.bin");
    yield* f.file("apps/mobile/modules/t3-terminal/android/.cxx/CMakeFiles/compiler.bin");
    yield* f.file("apps/mobile/modules/t3-terminal/android/src/build/source.java", "source");
    yield* f.file(".gradle/keep", "not mobile");
    const result = yield* f.evict();
    assert.strictEqual(result.directories, 5);
    assert.deepStrictEqual(result.artifactBreakdown, [
      { folderType: "android-build", logicalBytes: 24, folders: 3 },
      { folderType: "gradle-cache", logicalBytes: 16, folders: 2 },
    ]);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "apps/mobile/android/app/src/keep.java")));
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, ".gradle/keep")));
    assert.isTrue(
      yield* f.fs.exists(
        f.path.join(f.cwd, "apps/mobile/modules/t3-terminal/android/src/build/source.java"),
      ),
    );
  }).pipe(Effect.provide(layerGit)),
);

it.effect(
  "removes build outputs before node_modules and reports logical bytes per folder type",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.file("node_modules/.modules.yaml", "nodes");
      yield* f.file("apps/mobile/android/app/build/outputs/app.apk", "android");
      yield* f.file("apps/mobile/modules/t3-terminal/android/.gradle/cache.bin", "abc");
      yield* f.file("apps/web/dist/assets/index.js", "js");
      yield* f.file(".turbo/cache.json", "x");
      let reads = 0;
      const first = yield* Effect.gen(function* () {
        return yield* (yield* Artifacts.ForkWorktreeArtifacts).evict({
          cwd: f.cwd,
          blocked: Effect.sync(() => (++reads > 4 ? "a turn was queued" : null)),
        });
      }).pipe(Effect.provide(f.layer));
      assert.deepStrictEqual(first.artifactBreakdown, [
        { folderType: "android-build", logicalBytes: 7, folders: 1 },
      ]);
      assert.isFalse(yield* f.fs.exists(f.path.join(f.cwd, "apps/mobile/android/app/build")));
      assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/.modules.yaml")));
      const remaining = yield* f.evict();
      assert.deepStrictEqual(remaining.artifactBreakdown, [
        { folderType: "gradle-cache", logicalBytes: 3, folders: 1 },
        { folderType: "build-output", logicalBytes: 2, folders: 1 },
        { folderType: "cache", logicalBytes: 1, folders: 1 },
        { folderType: "node_modules", logicalBytes: 5, folders: 1 },
      ]);
    }).pipe(Effect.provide(layerGit)),
);

it.effect(
  "recognizes ignored Electron and release build outputs without widening the allowlist",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.file("apps/desktop/dist-electron/entry.js", "js");
      yield* f.file("release/installer.zip", "zip");
      yield* f.file("release-mock/installer.zip", "mock");
      yield* f.file("unknown/installer.zip", "keep");
      const result = yield* f.evict();
      assert.deepStrictEqual(result.artifactBreakdown, [
        { folderType: "build-output", logicalBytes: 9, folders: 3 },
      ]);
      assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "unknown/installer.zip")));
    }).pipe(Effect.provide(layerGit)),
);

const now = Date.parse("2026-10-19T00:00:00Z");
it.effect("a process cwd alias resolving to the canonical checkout still blocks", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("node_modules/.modules.yaml");
    const alias = f.path.join(f.root, "process-cwd-alias");
    yield* f.fs.symlink(f.cwd, alias);
    f.processes([alias]);
    assert.strictEqual((yield* f.evict()).directories, 0);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/.modules.yaml")));
  }).pipe(Effect.provide(layerGit)),
);
it.effect("accepts the real-shaped Kotlin cache inventory without protected content", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const build = "apps/mobile/android/app/build";
    for (const relative of kotlinCacheInventory)
      yield* f.file(`${build}/${relative}`, "compiler cache");
    yield* f.file(`${build}/outputs/apk/debug/app-debug.apk`, "generated APK");
    const result = yield* f.evict();
    assert.strictEqual(result.failed, false);
    assert.strictEqual(result.directories, 1, result.reason);
    assert.isFalse(yield* f.fs.exists(f.path.join(f.cwd, build)));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("visible unknown-file skips name the kept folder, reason and example path", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const build = "apps/mobile/android/app/build";
    yield* f.file(`${build}/outputs/app.apk`);
    yield* f.file(`${build}/outputs/notes.txt`, "keep notes");
    const kept = yield* f.evict();
    assert.strictEqual(kept.directories, 0);
    assert.include(kept.reason, `kept ${build}`);
    assert.include(kept.reason, "unrecognized file type");
    assert.include(kept.reason, "outputs/notes.txt");
    assert.notInclude(kept.reason, "Artifacts removed");
    yield* f.file(".turbo/cache.json");
    const partial = yield* f.evict();
    assert.strictEqual(partial.directories, 1);
    assert.include(partial.reason, `kept ${build}`);
    assert.isFalse(partial.artifactBreakdown.some((entry) => entry.folderType === "android-build"));
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, build, "outputs/app.apk")));
  }).pipe(Effect.provide(layerGit)),
);
it.effect("recognizes compiler output names but keeps a neighboring unknown text file", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const build = "apps/mobile/android/app/build";
    yield* f.file(`${build}/outputs/app.apk`);
    yield* f.file(`${build}/outputs/logs/manifest-merger-debug-report.txt`);
    yield* f.file(
      `${build}/kotlin/compileDebugKotlin/cacheable/caches-jvm/jvm/kotlin/class-attributes.tab.len`,
    );
    assert.strictEqual((yield* f.evict()).directories, 1);
    yield* f.file(`${build}/outputs/app.apk`);
    yield* f.file(`${build}/outputs/logs/notes.txt`, "not compiler output");
    assert.strictEqual((yield* f.evict()).directories, 0);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, build, "outputs/app.apk")));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("a shared-data target keeps the whole folder even when the link has another name", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const build = "apps/mobile/android/app/build";
    yield* f.file("_shared/private.json", "private");
    yield* f.file(`${build}/outputs/app.apk`);
    yield* f.fs.symlink(f.path.join(f.cwd, "_shared"), f.path.join(f.cwd, build, "alias.json"));
    assert.include((yield* f.evict()).reason, "protected");
    assert.strictEqual(
      yield* f.fs.readFileString(f.path.join(f.cwd, "_shared/private.json")),
      "private",
    );
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, build, "outputs/app.apk")));
  }).pipe(Effect.provide(layerGit)),
);

it.effect("rechecks workspace declarations before deleting package dependencies", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file("apps/web/node_modules/.modules.yaml");
    let reads = 0;
    f.processRead(
      Effect.gen(function* () {
        if (++reads === 2)
          yield* f.fs
            .writeFileString(f.path.join(f.cwd, "pnpm-workspace.yaml"), "packages: []\n")
            .pipe(Effect.orDie);
        return [];
      }),
    );
    assert.strictEqual((yield* f.evict()).directories, 0);
    assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "apps/web/node_modules/.modules.yaml")));
  }).pipe(Effect.provide(layerGit)),
);
it.effect("a source project in node_modules is not mistaken for an installed package", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.file(
      "node_modules/local-work/package.json",
      '{"name":"local-work","version":"1.0.0"}',
    );
    yield* f.file("node_modules/local-work/source.ts", "keep original source");
    const result = yield* f.evict();
    assert.strictEqual(result.directories, 0);
    assert.include(result.reason, "unrecognized file type");
    assert.strictEqual(
      yield* f.fs.readFileString(f.path.join(f.cwd, "node_modules/local-work/source.ts")),
      "keep original source",
    );
  }).pipe(Effect.provide(layerGit)),
);
it.effect(
  "sweep enforces off, settled/inactive, shared, terminal, running and pending-work guards",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.file("node_modules/.modules.yaml");
      const base = {
        id: ThreadId.make("artifact-thread"),
        title: "Test",
        projectId: ProjectId.make("artifact-project"),
        branch: "saved",
        worktreePath: f.cwd,
        activeRunId: null,
        status: "idle",
        pendingBackgroundTasks: [],
        pendingRuntimeRequest: null,
        pendingUserInput: null,
        queuedMessages: [],
        settledAt: DateTime.makeUnsafe(now - 120_000),
        createdAt: DateTime.makeUnsafe(now - 30 * 86_400_000),
        latestUserMessageAt: null,
        latestRunRequestedAt: null,
        latestRunStartedAt: null,
        latestRunCompletedAt: null,
      } as unknown as OrchestrationV2ThreadShell;
      let thread = base;
      let terminal = false;
      let terminalCwd: string | null = null;
      let terminalWorktree: string | null = null;
      let pending = false;
      let shared = false;
      let sessionLive = false;
      let sessionCwd = f.cwd;
      let sessionWorktree: string | null = null;
      let setupConfigured = true;
      let hasThread = true;
      let settings = { ...DEFAULT_SERVER_SETTINGS, worktreeArtifactEviction: false };
      const project = {
        id: base.projectId,
        projectId: base.projectId,
        workspaceRoot: f.repo,
        scripts: [{ id: "setup", name: "Setup", command: "install", runOnWorktreeCreate: true }],
      };
      const sql = ((strings: TemplateStringsArray) => {
        const query = strings.join("");
        if (query.includes("effect_outbox")) return Effect.succeed(pending ? [{}] : []);
        if (query.includes("projection_provider_sessions"))
          return Effect.succeed(
            sessionLive ? [{ id: "session", cwd: sessionCwd, worktreePath: sessionWorktree }] : [],
          );
        if (!hasThread) return Effect.succeed([]);
        return Effect.succeed([
          { threadId: base.id, worktreePath: f.cwd },
          ...(shared ? [{ threadId: "second", worktreePath: `${f.cwd}/.` }] : []),
        ]);
      }) as unknown as SqlClient.SqlClient;
      const sweep = yield* Artifacts.makeSweep({
        hasTerminal: () => terminal,
        terminals: () =>
          terminalCwd === null
            ? []
            : [
                {
                  threadId: "other",
                  terminalId: "other",
                  cwd: terminalCwd,
                  worktreePath: terminalWorktree,
                  status: "running",
                  pid: 1,
                  exitCode: null,
                  exitSignal: null,
                  hasRunningSubprocess: false,
                  label: "test",
                  updatedAt: "2026-10-19T00:00:00Z",
                },
              ],
        idle: storageCleanupThreadIdle,
        activityAt: storageCleanupActivityAt,
      }).pipe(
        Effect.provide(f.layer),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(Projections.ProjectionStoreV2, {
          getThreadShell: () => Effect.sync(() => thread),
        } as unknown as Projections.ProjectionStoreV2["Service"]),
        Effect.provideService(Projects.ProjectStoreV2, {
          listShells: () => Effect.succeed([project]),
          get: () =>
            Effect.succeed(
              Option.some({ ...project, scripts: setupConfigured ? project.scripts : [] }),
            ),
        } as unknown as Projects.ProjectStoreV2["Service"]),
        Effect.provideService(Settings.ServerSettingsService, {
          getSettings: Effect.sync(() => settings),
        } as unknown as Settings.ServerSettingsService["Service"]),
        Effect.provideService(Sessions.ProviderSessionManagerV2, {
          isLive: () => Effect.sync(() => sessionLive),
        } as unknown as Sessions.ProviderSessionManagerV2["Service"]),
      );
      const run = (existing: StorageCleanupReportEntry[] = []) =>
        Effect.gen(function* () {
          const entries: StorageCleanupReportEntry[] = [...existing];
          yield* sweep(settings, now, entries);
          return entries;
        });
      assert.lengthOf(yield* run(), 0);
      settings = { ...settings, worktreeArtifactEviction: true };
      hasThread = false;
      yield* f.file("apps/mobile/android/app/build/outputs/app.apk");
      assert.lengthOf(yield* run(), 0);
      assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/.modules.yaml")));
      assert.isTrue(
        yield* f.fs.exists(f.path.join(f.cwd, "apps/mobile/android/app/build/outputs/app.apk")),
      );
      hasThread = true;
      terminal = true;
      assert.include((yield* run())[0]!.reason, "open terminal");
      terminal = false;
      terminalCwd = f.root;
      assert.include((yield* run())[0]!.reason, "container");
      terminalCwd = null;
      const alias = f.path.join(f.root, "checkout-alias");
      yield* f.fs.symlink(f.cwd, alias);
      terminalCwd = f.home;
      terminalWorktree = alias;
      assert.include((yield* run())[0]!.reason, "T3 terminal metadata");
      terminalCwd = null;
      terminalWorktree = null;
      const setups = yield* SetupTracker.WorktreeSetupTracker;
      yield* setups.begin({
        threadId: base.id,
        branch: base.branch,
        baseRef: "main",
        stages: ["setup-script"],
        fiber: null,
      });
      yield* setups.update(base.id, (snapshot) => ({ ...snapshot, worktreePath: alias }));
      assert.include((yield* run())[0]!.reason, "T3-known setup");
      yield* setups.finish(base.id, "done");
      shared = true;
      assert.include((yield* run())[0]!.reason, "shared by 2");
      shared = false;
      pending = true;
      assert.include((yield* run())[0]!.reason, "pending work");
      pending = false;
      sessionLive = true;
      assert.include((yield* run())[0]!.reason, "provider session");
      sessionCwd = f.home;
      sessionWorktree = alias;
      assert.include((yield* run())[0]!.reason, "T3 provider metadata");
      sessionLive = false;
      sessionCwd = f.cwd;
      sessionWorktree = null;
      setupConfigured = false;
      assert.include((yield* run())[0]!.reason, "no project setup");
      setupConfigured = true;
      thread = { ...base, status: "running" };
      assert.include((yield* run())[0]!.reason, "running");
      thread = {
        ...base,
        latestRunId: null,
        latestUserMessageAt: DateTime.makeUnsafe(now - 1_000),
      };
      assert.include((yield* run())[0]!.reason, "queued");
      thread = { ...base, settledAt: DateTime.makeUnsafe(now - 1_000) };
      assert.include((yield* run())[0]!.reason, "settled moments ago");
      thread = {
        ...base,
        settledAt: null,
        latestUserMessageAt: DateTime.makeUnsafe(now - 86_400_000),
      };
      assert.include((yield* run())[0]!.reason, "less than 14");
      thread = base;
      let processChecks = 0;
      f.processRead(
        Effect.sync(() => {
          if (++processChecks === 3) thread = { ...base, status: "running" };
          return [];
        }),
      );
      assert.include((yield* run())[0]!.reason, "running");
      assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/.modules.yaml")));
      thread = base;
      f.processes([]);
      terminalCwd = f.home;
      processChecks = 0;
      f.processRead(
        Effect.sync(() => {
          if (++processChecks === 3) terminalWorktree = alias;
          return [];
        }),
      );
      assert.include((yield* run())[0]!.reason, "T3 terminal metadata");
      assert.isTrue(yield* f.fs.exists(f.path.join(f.cwd, "node_modules/.modules.yaml")));
      terminalCwd = null;
      terminalWorktree = null;
      f.processes([]);
      const entries = yield* run([
        {
          kind: "worktree",
          outcome: "kept",
          reason: "No whole-worktree rules apply",
          path: f.cwd,
          projectPath: null,
          threadId: base.id,
          threadTitle: base.title,
          bytes: null,
          files: null,
        },
      ]);
      assert.lengthOf(entries, 1);
      assert.include(entries[0]!.reason, "Artifacts removed");
      assert.strictEqual(entries[0]!.bytes, null);
      assert.deepStrictEqual(entries[0]!.artifactBreakdown, [
        { folderType: "android-build", logicalBytes: 8, folders: 1 },
        { folderType: "node_modules", logicalBytes: 8, folders: 1 },
      ]);
      assert.isTrue(yield* f.fs.exists(f.cwd));
    }).pipe(Effect.provide(layerGit)),
);
