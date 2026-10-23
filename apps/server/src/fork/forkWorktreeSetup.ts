import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Path from "effect/Path";
import * as Config from "../config.ts";

/** Keep recovery state outside the checkout, so it survives eviction and restarts. */
export const makeSetupMarker = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Config.ServerConfig;
  const directory = path.join(config.stateDir, "fork-worktree-setup");
  return (cwd: string) =>
    Effect.gen(function* () {
      const normalized = yield* fs.realPath(cwd).pipe(
        Effect.catch(() =>
          fs.realPath(path.dirname(cwd)).pipe(
            Effect.map((parent) => path.join(parent, path.basename(cwd))),
            Effect.orElseSucceed(() => path.resolve(cwd)),
          ),
        ),
      );
      const key = Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(normalized)));
      const target = path.join(directory, key);
      return {
        pending: fs.exists(target),
        mark: fs
          .makeDirectory(directory, { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(target, cwd))),
        clear: fs.remove(target, { force: true }),
      };
    });
});
