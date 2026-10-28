// @effect-diagnostics nodeBuiltinImport:off - plain Node tests on temporary folders.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";

import { forkVpCommand } from "./fork-setup-vp.ts";

function makeRoot(): { readonly path: string } & Disposable {
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-setup-vp-"));
  return { path, [Symbol.dispose]: () => NodeFS.rmSync(path, { recursive: true, force: true }) };
}

function writeVp(dir: string): string {
  NodeFS.mkdirSync(dir, { recursive: true });
  const path = NodePath.join(dir, "vp");
  NodeFS.writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
  return path;
}

it("prefers vp on PATH over the main checkout", () => {
  using root = makeRoot();
  const onPath = writeVp(NodePath.join(root.path, "bin"));
  writeVp(NodePath.join(root.path, "main", "node_modules", ".bin"));
  const env = { PATH: NodePath.join(root.path, "bin"), HOME: root.path };
  expect(forkVpCommand(NodePath.join(root.path, "main"), env, "linux")).toBe(
    JSON.stringify(onPath),
  );
});

it("falls back to the main checkout's vp without PATH", () => {
  using root = makeRoot();
  const inMain = writeVp(NodePath.join(root.path, "main", "node_modules", ".bin"));
  const env = { PATH: "/usr/bin:/bin", HOME: root.path };
  expect(forkVpCommand(NodePath.join(root.path, "main"), env, "linux")).toBe(
    JSON.stringify(inMain),
  );
});

it("names the searched paths when vp is missing", () => {
  using root = makeRoot();
  const env = { PATH: "", HOME: root.path };
  const main = NodePath.join(root.path, "main");
  expect(() => forkVpCommand(main, env, "linux")).toThrow(
    NodePath.join(main, "node_modules", ".bin", "vp"),
  );
});

it("leaves Windows to the shell, which finds the vp.cmd shim", () => {
  expect(forkVpCommand("/main", { PATH: "" }, "win32")).toBe("vp");
});
