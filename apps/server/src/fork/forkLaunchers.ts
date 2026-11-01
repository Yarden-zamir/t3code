/**
 * Fork: after the service launcher switches this T3 home to another runtime, the `t3` launchers
 * still point at the old one, so `t3 --version` names the old version. `t3 update` repoints only
 * the launcher it ran through. This repoints each launcher of this home.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  launcherOwnsVersionsDir,
  PINNED_RUNTIME_LAUNCHERS_FILE,
  pinnedRuntimeVersionsDir,
  recordPinnedRuntimeLauncher,
} from "../cloud/pinnedRuntime.ts";

/**
 * Points the recorded launchers and the default `<bin dir>/t3` that link into this home's
 * `runtime/versions` at `entryPath`. A failed launcher is logged; the others still change.
 * Limit: a Windows `t3.cmd` shim stays, as Windows has no self-updating background service.
 * Revisit when the fork publishes a Windows server.
 */
export const relinkLaunchers = Effect.fn("ForkLaunchers.relink")(function* (input: {
  readonly baseDir: string;
  readonly entryPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const recorded = yield* fs
    .readFileString(path.join(input.baseDir, "runtime", PINNED_RUNTIME_LAUNCHERS_FILE))
    .pipe(Effect.orElseSucceed(() => ""));
  const binDir = environment["T3CODE_INSTALL_BIN_DIR"] || path.join(home, ".local", "bin");
  const candidates = new Set([
    ...recorded
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    path.join(binDir, "t3"),
  ]);
  const relinked: Array<string> = [];
  for (const launcher of candidates) {
    const target = yield* fs.readLink(launcher).pipe(Effect.option);
    if (Option.isNone(target)) continue;
    const resolved = path.resolve(path.dirname(launcher), target.value);
    if (resolved === input.entryPath || !launcherOwnsVersionsDir(path, versionsDir, resolved)) {
      continue;
    }
    const temporary = `${launcher}.relink-tmp`;
    // Recorded first, so a prune never removes the runtime that the launcher points at.
    const done = yield* recordPinnedRuntimeLauncher({ baseDir: input.baseDir, launcher }).pipe(
      Effect.andThen(fs.remove(temporary, { force: true })),
      Effect.andThen(fs.symlink(input.entryPath, temporary)),
      Effect.andThen(fs.rename(temporary, launcher)),
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not point a t3 launcher at this version.", {
          launcher,
          error,
        }).pipe(Effect.as(false)),
      ),
    );
    if (done) relinked.push(launcher);
  }
  return relinked;
});
