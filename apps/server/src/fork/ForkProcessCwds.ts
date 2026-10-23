import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";

export class ForkProcessCwds extends Context.Service<
  ForkProcessCwds,
  {
    /** null means visibility is incomplete: eviction must fail closed. */
    readonly read: Effect.Effect<ReadonlyArray<string> | null>;
  }
>()("t3/fork/ForkProcessCwds") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const read = Effect.gen(function* () {
    if (platform === "linux") {
      const cwds: string[] = [];
      for (const pid of yield* fs.readDirectory("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        const result = yield* fs.readLink(`/proc/${pid}/cwd`).pipe(Effect.result);
        if (result._tag === "Success") cwds.push(result.success);
        else if (result.failure.reason._tag !== "NotFound") return null;
      }
      // A functioning proc scan must at least see the server's own working directory.
      return cwds.length === 0 ? null : cwds;
    }
    if (platform !== "darwin") return null;
    // NUL-delimited fields preserve spaces and newlines in working-directory names.
    const result = yield* runner.run({
      command: "lsof",
      args: ["-n", "-P", "-a", "-d", "cwd", "-F0pn"],
      timeout: "10 seconds",
      maxOutputBytes: 8 * 1024 * 1024,
    });
    if (
      result.code !== 0 ||
      result.stdoutTruncated ||
      result.stderr.trim() !== "" ||
      result.stdoutInvalidUtf8
    )
      return null;
    const cwds = result.stdout
      .split("\0")
      .map((field) => field.replace(/^\n/, ""))
      .filter((field) => field.startsWith("n/"))
      .map((field) => field.slice(1));
    return cwds.length === 0 ? null : cwds;
  }).pipe(Effect.orElseSucceed(() => null));
  return ForkProcessCwds.of({ read });
});

export const layer = Layer.effect(ForkProcessCwds, make);
