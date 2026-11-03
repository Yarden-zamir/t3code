import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const makeLeases = (permits: number) => {
  const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  return <A, E, R>(key: string, take: number, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const lease = leases.get(key) ?? { semaphore: Semaphore.makeUnsafe(permits), users: 0 };
      leases.set(key, lease);
      lease.users++;
      return lease.semaphore
        .withPermits(take)(effect)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lease.users--;
              if (lease.users === 0) leases.delete(key);
            }),
          ),
        );
    });
};

const workspaceLeases = makeLeases(1);

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => workspaceLeases(cwd, 1, effect);

const repositoryLeases = makeLeases(Number.MAX_SAFE_INTEGER);

/**
 * Keyed by the real path of the Git common folder, so all worktrees of a repository share it.
 * Worktree creations run together; branch cleanup waits for them and holds the lease alone.
 */
export const withRepositoryLease = <A, E, R>(
  gitCommonDir: string,
  mode: "shared" | "exclusive",
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  repositoryLeases(gitCommonDir, mode === "shared" ? 1 : Number.MAX_SAFE_INTEGER, effect);
