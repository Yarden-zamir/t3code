import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { relinkLaunchers } from "./forkLaunchers.ts";

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "points each launcher of this T3 home at the active runtime and leaves other links alone",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-launchers-" });
      const baseDir = path.join(root, "home");
      const versions = path.join(baseDir, "runtime", "versions");
      const oldEntry = path.join(versions, "0.0.1-nightly.20261031.10000", "t3");
      const newEntry = path.join(versions, "0.0.1-nightly.20261101.20000", "t3");
      for (const entry of [oldEntry, newEntry]) {
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
      }
      // The default launcher of the install script, and a recorded one in another folder.
      const binDir = path.join(root, "bin");
      const recordedDir = path.join(root, "custom");
      const foreignTarget = path.join(root, "elsewhere", "t3");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.makeDirectory(recordedDir, { recursive: true });
      yield* fs.makeDirectory(path.dirname(foreignTarget), { recursive: true });
      yield* fs.writeFileString(foreignTarget, "");
      const defaultLauncher = path.join(binDir, "t3");
      const recordedLauncher = path.join(recordedDir, "t3");
      const foreignLauncher = path.join(recordedDir, "t3-other");
      yield* fs.symlink(oldEntry, defaultLauncher);
      yield* fs.symlink(oldEntry, recordedLauncher);
      yield* fs.symlink(foreignTarget, foreignLauncher);
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "launchers"),
        `\n${recordedLauncher}\n${foreignLauncher}\n`,
      );

      const relinked = yield* relinkLaunchers({ baseDir, entryPath: newEntry }).pipe(
        Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: binDir }),
      );

      expect([...relinked].toSorted()).toEqual([defaultLauncher, recordedLauncher].toSorted());
      expect(yield* fs.readLink(defaultLauncher)).toBe(newEntry);
      expect(yield* fs.readLink(recordedLauncher)).toBe(newEntry);
      expect(yield* fs.readLink(foreignLauncher)).toBe(foreignTarget);
      // A later prune keeps what the default launcher points at, so it is recorded too.
      const recorded = yield* fs.readFileString(path.join(baseDir, "runtime", "launchers"));
      expect(recorded.split("\n")).toContain(defaultLauncher);
      // A second run has nothing to do.
      expect(
        yield* relinkLaunchers({ baseDir, entryPath: newEntry }).pipe(
          Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: binDir }),
        ),
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
