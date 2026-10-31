// @effect-diagnostics nodeBuiltinImport:off -- Opening with O_NOFOLLOW makes the permission check apply to the file read.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const MAX_KEY_BYTES = 4096;

export async function readUsageSourceKey(
  path: string,
  host: { readonly platform: NodeJS.Platform; readonly userId: number | undefined },
): Promise<string> {
  if (
    host.platform === "win32" ||
    !NodePath.isAbsolute(path) ||
    host.userId === undefined ||
    NodeFS.constants.O_NOFOLLOW === undefined
  ) {
    throw new Error("An owner-only file on a POSIX server is required.");
  }

  const file = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== host.userId || (stat.mode & 0o077) !== 0) {
      throw new Error("The key file must be owned by the server user and private.");
    }
    const buffer = Buffer.alloc(MAX_KEY_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length === 0 || length > MAX_KEY_BYTES) throw new Error("Invalid key length.");
    const key = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)).trim();
    if (!key || /[\r\n\0]/.test(key)) throw new Error("Invalid key format.");
    return key;
  } finally {
    await file.close();
  }
}
