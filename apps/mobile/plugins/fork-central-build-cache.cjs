const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withAppBuildGradle } = require("expo/config-plugins");
const cache = require("../../../scripts/lib/fork-build-cache.cjs");

module.exports = function forkCentralBuildCache(config) {
  if (!cache.enabled()) return config;
  config = withDangerousMod(config, [
    "android",
    (next) => {
      cache.androidBuildLink(path.resolve(next.modRequest.projectRoot, "../.."));
      return next;
    },
  ]);
  return withAppBuildGradle(config, (next) => {
    const paths = cache.workspacePaths(
      path.resolve(next.modRequest.projectRoot, "../.."),
      "gradle",
    );
    const script = "fork-central-build-cache.gradle";
    fs.writeFileSync(
      path.join(next.modRequest.platformProjectRoot, "app", script),
      cache.gradleLeaseScript(paths),
    );
    const hook = `apply from: '${script}'`;
    if (!next.modResults.contents.includes(hook))
      next.modResults.contents = `${hook}\n${next.modResults.contents}`;
    return next;
  });
};
