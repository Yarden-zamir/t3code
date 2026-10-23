import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const leases = new Map<
  string,
  { semaphore: Semaphore.Semaphore; users: number; holder: symbol | undefined }
>();

// Fork: work that runs inside a lease, such as project setup opening a terminal during turn
// startup, takes the same lease again. A fiber that outlives the lease no longer matches its
// holder, so it waits like any other caller.
const heldLeases = Context.Reference<ReadonlyMap<string, symbol>>("t3/workspace/heldLeases", {
  defaultValue: () => new Map(),
});

export const withWorkspaceLease = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.service(heldLeases), (held) => {
    const existing = leases.get(cwd);
    const token = held.get(cwd);
    if (token !== undefined && existing?.holder === token) return effect;
    const lease = existing ?? { semaphore: Semaphore.makeUnsafe(1), users: 0, holder: undefined };
    leases.set(cwd, lease);
    lease.users++;
    const holder = Symbol(cwd);
    return lease.semaphore
      .withPermit(
        Effect.sync(() => {
          lease.holder = holder;
        }).pipe(
          Effect.andThen(effect),
          Effect.provideService(heldLeases, new Map([...held, [cwd, holder]])),
          Effect.ensuring(
            Effect.sync(() => {
              lease.holder = undefined;
            }),
          ),
        ),
      )
      .pipe(
        Effect.ensuring(
          Effect.sync(() => {
            lease.users--;
            if (lease.users === 0) leases.delete(cwd);
          }),
        ),
      );
  });
