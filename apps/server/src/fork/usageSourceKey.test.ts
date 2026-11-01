// @effect-diagnostics nodeBuiltinImport:off -- Exercise real file modes and symlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { readUsageSourceKey } from "./usageSourceKey.ts";

it("reads an owner-only regular key file and refuses unsafe alternatives", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-key-"));
  const host = {
    platform: HostProcess.Platform.defaultValue(),
    userId: HostProcess.UserId.defaultValue(),
  };
  try {
    const key = NodePath.join(dir, "key");
    await NodeFSP.writeFile(key, "example-key\n", { mode: 0o600 });
    if (host.platform === "win32") {
      await expect(readUsageSourceKey(key, host)).rejects.toThrow();
      return;
    }
    expect(await readUsageSourceKey(key, host)).toBe("example-key\n");
    await NodeFSP.chmod(key, 0o644);
    await expect(readUsageSourceKey(key, host)).rejects.toThrow();
    await NodeFSP.chmod(key, 0o600);
    const link = NodePath.join(dir, "link");
    await NodeFSP.symlink(key, link);
    await expect(readUsageSourceKey(link, host)).rejects.toThrow();
    await expect(readUsageSourceKey("relative-key", host)).rejects.toThrow();
    await NodeFSP.writeFile(key, "x".repeat(4097));
    await expect(readUsageSourceKey(key, host)).rejects.toThrow();
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
