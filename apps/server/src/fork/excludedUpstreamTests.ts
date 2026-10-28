/**
 * Fork: upstream test files that fork test runs skip, each with its reason. `vite.config.ts`
 * excludes them, so Fork CI, Fork Sync and `vp test run` skip them. Remove an entry when its
 * reason is gone.
 */
export const FORK_EXCLUDED_UPSTREAM_TESTS: string[] = [
  // The fork hides t3_environment_link: links are machine map arrows (`orchestratorTools.fork.test.ts`).
  "**/src/peer/PeerLinkRequests.test.ts",
];
