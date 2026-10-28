/**
 * Fork: upstream test files that fork test runs skip, each with its reason. `vite.config.ts`
 * excludes them, so Fork CI, Fork Sync and `vp test run` skip them. Remove an entry when its
 * reason is gone.
 */
export const FORK_EXCLUDED_UPSTREAM_TESTS: ReadonlyArray<string> = [];
