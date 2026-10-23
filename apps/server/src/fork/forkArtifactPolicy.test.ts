import { describe, expect, it } from "vite-plus/test";
import { looksGenerated } from "./forkArtifactPolicy.ts";
import { kotlinCacheInventory } from "./fixtures/kotlinCacheInventory.ts";

describe("Kotlin incremental cache classification", () => {
  it("accepts every path in the read-only real Kotlin inventory", () => {
    expect(kotlinCacheInventory).toHaveLength(80);
    expect(
      kotlinCacheInventory.filter((file) => !looksGenerated("android-build", file, false)),
    ).toEqual([]);
  });
  it.each([
    "outputs/classes.tab",
    "outputs/classes.tab_i",
    "outputs/classes.tab.keystream.len",
    "kotlin/compileDebugKotlin/cacheable/classes.tab.len",
    "kotlin/compileDebugKotlin/cacheable/caches-jvm-legacy/lookups/file-to-id.tab",
    "kotlin/compileDebugKotlin/cacheable/caches-jvm/lookups/file-to-id.len",
    "kotlin/compileDebugKotlin/cacheable/caches-jvm/lookups/notes.tab",
    "kotlin/compileDebugKotlin/cacheable/caches-jvm/jvm/kotlin/source-to-classes.kt",
    "kotlin/compileDebugKotlin/cacheable/caches-jvm/inputs/source-to-output.tab.secret",
  ])("does not broaden acceptance to %s", (file) => {
    expect(looksGenerated("android-build", file, false)).toBe(false);
  });
  it("does not apply the Kotlin build exception to another folder type", () => {
    expect(looksGenerated("gradle-cache", kotlinCacheInventory[0]!, false)).toBe(false);
  });
});
