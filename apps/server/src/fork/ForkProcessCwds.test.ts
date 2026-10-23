import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Runner from "../processRunner.ts";
import * as Processes from "./ForkProcessCwds.ts";

const readMac = (stdout: string, stderr = "", code = 0, stdoutTruncated = false) =>
  Effect.gen(function* () {
    return yield* (yield* Processes.ForkProcessCwds).read;
  }).pipe(
    Effect.provide(
      Processes.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "darwin"),
            FileSystem.layerNoop({}),
            Layer.mock(Runner.ProcessRunner)({
              run: () =>
                Effect.succeed({
                  stdout,
                  stderr,
                  code: code as never,
                  timedOut: false,
                  stdoutTruncated,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                }),
            }),
          ),
        ),
      ),
    ),
  );

it.effect("reads macOS cwd records without splitting spaces or newlines in paths", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* readMac("p12\0ncwd\0\np14\0n/work tree\0\np15\0n/path\nwith newline\0\n"),
      ["/work tree", "/path\nwith newline"],
    );
  }),
);

it.effect("refuses incomplete or unsupported process visibility", () =>
  Effect.gen(function* () {
    assert.isNull(yield* readMac("p12\0n/worktree\0", "permission denied"));
    assert.isNull(yield* readMac("p12\0n/worktree\0", "", 1));
    assert.isNull(yield* readMac("p12\0n/worktree\0", "", 0, true));
    assert.isNull(yield* readMac(""));
    const unsupported = yield* Effect.gen(function* () {
      return yield* (yield* Processes.ForkProcessCwds).read;
    }).pipe(
      Effect.provide(
        Processes.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(HostProcess.Platform, "win32"),
              FileSystem.layerNoop({}),
              Layer.mock(Runner.ProcessRunner)({}),
            ),
          ),
        ),
      ),
    );
    assert.isNull(unsupported);
  }),
);

it.effect.each(["denied", "empty"])("refuses incomplete Linux cwd visibility: %s", (mode) =>
  Effect.gen(function* () {
    const denied = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readLink",
      pathOrDescriptor: "/proc/12/cwd",
    });
    const result = yield* Effect.gen(function* () {
      return yield* (yield* Processes.ForkProcessCwds).read;
    }).pipe(
      Effect.provide(
        Processes.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(HostProcess.Platform, "linux"),
              Layer.succeed(
                FileSystem.FileSystem,
                FileSystem.makeNoop({
                  readDirectory: () => Effect.succeed(mode === "empty" ? [] : ["12"]),
                  readLink: () => Effect.fail(denied),
                }),
              ),
              Layer.mock(Runner.ProcessRunner)({}),
            ),
          ),
        ),
      ),
    );
    assert.isNull(result);
  }),
);
