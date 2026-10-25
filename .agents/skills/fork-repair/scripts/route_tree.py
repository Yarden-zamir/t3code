# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Regenerates apps/web/src/routeTree.gen.ts, as the TanStack Router Vite plugin does.

Use it when a merge conflicts in the generated route tree, or moves route files. It takes the
merged side's copy first, so that the generator starts from a clean file, then stages the result.
"""

import subprocess
import sys

import common

ROUTE_TREE = "apps/web/src/routeTree.gen.ts"

# The plugin's own generator, resolved through the plugin, with the options of apps/web/vite.config.ts.
GENERATE = """
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const root = process.cwd();
const plugin = realpathSync(`${root}/node_modules/@tanstack/router-plugin`);
const require = createRequire(pathToFileURL(`${plugin}/package.json`));
const { Generator, getConfig } = await import(pathToFileURL(require.resolve("@tanstack/router-generator")).href);
const config = getConfig({ autoCodeSplitting: true }, root);
await new Generator({ config, root }).run();
"""


def main() -> None:
    root = common.repo_root()
    if ROUTE_TREE in common.git("diff", "--name-only", "--diff-filter=U", cwd=root).split():
        common.git("checkout", "--theirs", "--", ROUTE_TREE, cwd=root)
    result = subprocess.run(
        ["node", "--input-type=module", "-e", GENERATE],
        cwd=root / "apps/web",
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        common.fail(f"Route tree generation failed:\n{result.stderr.strip()}")
    common.git("add", "--", ROUTE_TREE, cwd=root)
    print(f"Regenerated and staged {ROUTE_TREE}.")


if __name__ == "__main__":
    sys.exit(main())
