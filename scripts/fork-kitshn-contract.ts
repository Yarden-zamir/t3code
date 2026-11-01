#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off - plain Node script.
/* oxlint-disable t3code/no-global-process-runtime -- A plain Node script picks the daemon build of its host. */
// Fork: kitshn's provider contract scenarios (K-723) against the built server, with the assets of
// the kitshn release that pins `@kitshn/local`, checked against its SHA256SUMS. Linux or macOS.
//   vp run --filter t3 build:bundle && node scripts/fork-kitshn-contract.ts

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

const PIN_PREFIX = '"@kitshn/local": https://github.com/Yarden-zamir/kitshn/releases/download/';
const LOCAL_ASSET = "/kitshn-local.tgz";
// A port that no other test of the fork uses; the server runs once per scenario.
const SERVER_PORT = 37991;

const fail = (message: string): never => {
  console.error(`fork-kitshn-contract: ${message}`);
  process.exit(1);
};

const repoRoot = process.cwd();
const pin = NodeFS.readFileSync(NodePath.join(repoRoot, "pnpm-workspace.yaml"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .find((line) => line.startsWith(PIN_PREFIX) && line.endsWith(LOCAL_ASSET));
const release =
  pin?.slice(0, -LOCAL_ASSET.length).slice(pin.indexOf("https://")) ??
  fail("pnpm-workspace.yaml pins @kitshn/local to no kitshn release asset.");

const daemonAsset = (() => {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "linux") return `kitshn-linux-${arch}.gz`;
  if (process.platform === "darwin") return `kitshn-darwin-${arch}.gz`;
  return fail(`the kitshn contract tests run on Linux and macOS, not ${process.platform}.`);
})();

const server = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");
if (!NodeFS.existsSync(server)) fail(`${server} is missing. Run: vp run --filter t3 build:bundle`);

const download = async (asset: string) => {
  const response = await fetch(`${release}/${asset}`);
  if (!response.ok) fail(`${release}/${asset} answered ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
};

const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kitshn-contract-"));
try {
  const sums = new Map(
    (await download("SHA256SUMS"))
      .toString("utf8")
      .split("\n")
      .map((line) =>
        line
          .trim()
          .split(" ")
          .filter((part) => part !== ""),
      )
      .filter((parts) => parts.length === 2)
      // `sha256sum -b` marks a name with `*`.
      .map(([sum = "", name = ""]) => [name.startsWith("*") ? name.slice(1) : name, sum] as const),
  );
  const verified = async (asset: string) => {
    const bytes = await download(asset);
    const expected = sums.get(asset) ?? fail(`SHA256SUMS of ${release} does not list ${asset}.`);
    const actual = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) fail(`${asset} does not match SHA256SUMS.`);
    return bytes;
  };

  const daemon = NodePath.join(folder, "kitshn");
  NodeFS.writeFileSync(daemon, NodeZlib.gunzipSync(await verified(daemonAsset)), { mode: 0o755 });
  const tests = NodePath.join(folder, "kitshn-contract-tests.tgz");
  NodeFS.writeFileSync(tests, await verified("kitshn-contract-tests.tgz"));

  const run = (command: string, args: ReadonlyArray<string>) =>
    NodeChildProcess.spawnSync(command, args, { cwd: folder, stdio: "inherit" }).status ?? 1;
  const installed = run("npm", ["install", "--no-save", "--no-audit", "--no-fund", tests]);
  if (installed !== 0) fail(`npm could not install ${tests}.`);
  process.exitCode = run(NodePath.join(folder, "node_modules/.bin/kitshn-contract"), [
    "--daemon",
    daemon,
    "--provider",
    // `exec`: a stop signal reaches T3 itself, not a shell around it.
    `exec node ${server} serve --port ${SERVER_PORT} --host 127.0.0.1 --base-dir "$(mktemp -d)"`,
  ]);
} finally {
  NodeFS.rmSync(folder, { recursive: true, force: true });
}
