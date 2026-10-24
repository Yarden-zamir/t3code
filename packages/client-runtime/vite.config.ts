import "vite-plus/test/config";
import { viteCacheDir as forkViteCacheDir } from "../../scripts/lib/fork-build-cache.cjs";
import { defineConfig } from "vite-plus";

export default defineConfig({
  cacheDir: forkViteCacheDir(import.meta.url)!,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["../shared/src/testing/longTempDir.ts", "../shared/src/testing/providerEnv.ts"],
  },
});
