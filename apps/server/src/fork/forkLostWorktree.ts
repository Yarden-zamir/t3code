import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ServerSettings from "../serverSettings.ts";

/**
 * Fork: the saved worktree path of a thread whose folder is gone, or null. With
 * `restoreWorktreesOnResume` on, such a thread counts as detached and may move to a new worktree.
 */
export const makeLostWorktreePath = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const settings = yield* ServerSettings.ServerSettingsService;
  return Effect.fn("ForkLostWorktree.path")(function* (thread: {
    readonly worktreePath: string | null;
  }) {
    if (thread.worktreePath === null) return null;
    const enabled = yield* settings.getSettings.pipe(
      Effect.map((current) => current.restoreWorktreesOnResume),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) return null;
    const exists = yield* fileSystem
      .exists(thread.worktreePath)
      .pipe(Effect.orElseSucceed(() => true));
    return exists ? null : thread.worktreePath;
  });
});
