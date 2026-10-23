import type { ForkArtifactFolderType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { makeWorkspaceDependencies } from "./forkWorkspaceDependencies.ts";

// Exact checkout-relative paths. These are not basename rules or deletion globs.
const paths = {
  "android-build": [
    "apps/mobile/android/app/build",
    "apps/mobile/android/build",
    "apps/mobile/android/.cxx",
    "apps/mobile/android/app/.cxx",
    "apps/mobile/modules/t3-agent-notifications/android/build",
    "apps/mobile/modules/t3-agent-notifications/android/.cxx",
    "apps/mobile/modules/t3-composer-editor/android/build",
    "apps/mobile/modules/t3-composer-editor/android/.cxx",
    "apps/mobile/modules/t3-native-controls/android/build",
    "apps/mobile/modules/t3-native-controls/android/.cxx",
    "apps/mobile/modules/t3-review-diff/android/build",
    "apps/mobile/modules/t3-review-diff/android/.cxx",
    "apps/mobile/modules/t3-terminal/android/build",
    "apps/mobile/modules/t3-terminal/android/.cxx",
    "apps/mobile/modules/t3-widget-expiry/android/build",
    "apps/mobile/modules/t3-widget-expiry/android/.cxx",
  ],
  "gradle-cache": [
    "apps/mobile/.gradle",
    "apps/mobile/android/.gradle",
    "apps/mobile/android/app/.gradle",
    "apps/mobile/modules/t3-agent-notifications/android/.gradle",
    "apps/mobile/modules/t3-composer-editor/android/.gradle",
    "apps/mobile/modules/t3-native-controls/android/.gradle",
    "apps/mobile/modules/t3-review-diff/android/.gradle",
    "apps/mobile/modules/t3-terminal/android/.gradle",
    "apps/mobile/modules/t3-widget-expiry/android/.gradle",
  ],
  "build-output": [
    "apps/server/dist",
    "apps/server/dist-exe",
    "apps/web/dist",
    "apps/marketing/dist",
    "apps/machine-map/dist",
    "apps/desktop/dist-electron",
    "apps/mobile/dist",
    "apps/mobile/web-build",
    "infra/relay/dist",
    "release",
    "release-mock",
    "native/resource-monitor/target",
  ],
  cache: [
    ".turbo",
    ".vite",
    ".vite-plus",
    "apps/web/.vite",
    "apps/web/.vite-plus",
    "apps/web/.tanstack",
    "apps/server/.vite",
    "apps/server/.vite-plus",
    "apps/mobile/.expo",
    "apps/mobile/.vite-plus",
    "apps/marketing/.astro",
  ],
} as const;

export const makeArtifactCandidates = Effect.gen(function* () {
  const dependencies = yield* makeWorkspaceDependencies;
  return (cwd: string) =>
    Effect.gen(function* () {
      const candidates: { relative: string; folderType: ForkArtifactFolderType }[] = [];
      for (const folderType of [
        "android-build",
        "gradle-cache",
        "build-output",
        "cache",
      ] as const) {
        for (const relative of paths[folderType]) candidates.push({ relative, folderType });
      }
      for (const relative of yield* dependencies(cwd))
        candidates.push({ relative, folderType: "node_modules" });
      return candidates;
    });
});

const outputExtensions = new Set([
  "js",
  "cjs",
  "mjs",
  "css",
  "html",
  "json",
  "map",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "ico",
  "gif",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "wasm",
  "node",
  "zip",
  "gz",
  "tgz",
  "tar",
  "zst",
  "dmg",
  "exe",
  "appimage",
  "yml",
  "yaml",
  "blockmap",
  "sha256",
  "pak",
  "dat",
  "bin",
  "a",
  "rlib",
  "rmeta",
  "o",
  "obj",
  "d",
  "so",
  "dylib",
  "xml",
  "class",
  "dex",
  "jar",
  "apk",
  "aab",
  "aar",
  "flat",
  "pb",
  "properties",
  "kotlin_module",
  "kotlin_metadata",
  "prof",
  "profm",
  "r8",
  "log",
  "cmake",
  "ninja",
  "lock",
  "tmp",
  "tsbuildinfo",
  "bundle",
  "hbc",
  "bc",
  "sym",
  "symbols",
  "pdb",
]);
const textOutputs = new Set([
  "mapping.txt",
  "r.txt",
  "r-def.txt",
  "package-aware-r.txt",
  "stableids.txt",
  "typedefs.txt",
  "dex-renamer-state.txt",
  "configuration.txt",
  "seeds.txt",
  "usage.txt",
  "missing_rules.txt",
  "targetdirectories.txt",
  "cmake.check_cache",
  "cmake.verify_globs",
  "metadata_generation_command.txt",
  "build_command.txt",
  "cmake_server_log.txt",
  "cmakecache.txt",
  "cmakeerror.log",
  "cmakeoutput.log",
  "cachedir.tag",
  "sha256sums",
  "makefile",
  ".ninja_deps",
  ".ninja_log",
]);

// Kotlin incremental tables can have source-like names. Only this compiler cache
// location admits their multipart suffixes; it is not a general .tab/.len rule.
const kotlinIncrementalTable =
  /^kotlin\/[A-Za-z0-9_-]+\/cacheable\/caches-jvm\/(?:inputs\/source-to-output|jvm\/kotlin\/(?:class-attributes|class-fq-name-to-source|internal-name-to-source|proto|source-to-classes|subtypes|supertypes)|lookups\/(?:file-to-id|id-to-file|lookups))\.tab(?:_i(?:\.len)?|(?:\.keystream(?:\.len)?|\.len|\.values\.at)?)$/;
const kotlinCounterTable =
  /^kotlin\/[A-Za-z0-9_-]+\/cacheable\/caches-jvm\/lookups\/counters\.tab$/;

// Extension and path rules classify conservatively; they do not prove provenance
// or distinguish every hand-written ignored .js/.json file from generated output.
export function looksGenerated(
  folderType: ForkArtifactFolderType,
  relative: string,
  dependencyPayload: boolean,
): boolean {
  const name = relative.split("/").at(-1)!.toLowerCase();
  if (folderType === "node_modules") {
    if (dependencyPayload) return true;
    for (const prefix of [".vite/", ".vite-plus/", ".cache/"])
      if (relative.startsWith(prefix))
        return looksGenerated("cache", relative.slice(prefix.length), false);
    return (
      [
        ".modules.yaml",
        ".package-lock.json",
        ".pnpm-workspace-state-v1.json",
        ".yarn-integrity",
      ].includes(relative) || relative === ".pnpm/lock.yaml"
    );
  }
  if (
    folderType === "android-build" &&
    (kotlinIncrementalTable.test(relative) || kotlinCounterTable.test(relative))
  )
    return true;
  if (/^(?:notes?|draft|todo|readme|important|private|source|src)(?:[._-]|$)/.test(name))
    return false;
  if (name.endsWith(".d.ts")) return true;
  if (
    (folderType === "android-build" || folderType === "gradle-cache") &&
    (/^manifest-merger-[\w-]+-report\.txt$/.test(name) ||
      /^lint-results-[\w-]+\.txt$/.test(name) ||
      name.endsWith(".apk.idsig"))
  )
    return true;
  if (/\.ya?ml$/.test(name)) return /^(?:nightly|latest)(?:[-.][\w.-]+)?\.ya?ml$/.test(name);
  if (/\.(?:sqlite|sqlite3|db|md|mdx|tsx?|jsx|rs|java|kt|c|cpp|h)$/.test(name)) {
    return (
      (relative.startsWith("generated/") ||
        relative.includes("/generated/") ||
        relative.includes("/CMakeFiles/")) &&
      /\.(?:java|kt|c|cpp|h|rs)$/.test(name)
    );
  }
  return (
    outputExtensions.has(name.split(".").at(-1)!) ||
    textOutputs.has(name) ||
    /^[a-f\d]{16,}$/i.test(name)
  );
}
