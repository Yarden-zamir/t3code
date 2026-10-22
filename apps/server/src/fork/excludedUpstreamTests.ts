/**
 * Fork: upstream test files that fork test runs skip, each with its reason. `vite.config.ts`
 * excludes them, so Fork CI, Fork Sync and `vp test run` skip them. Remove an entry when its
 * reason is gone.
 */
export const FORK_EXCLUDED_UPSTREAM_TESTS = [
  // The adopted link PRs keep manual links in `peer_environment_links`, which the fork never
  // creates (docs/fork/operations.md "Migrations"). `MachinePeers.test.ts` covers the arrow links
  // over the same forwarding and delegation. Remove these when upstream main has the migration.
  "**/src/peer/PeerLinks.test.ts",
  "**/src/peer/PeerForwarding.test.ts",
  "**/src/peer/RemoteDelegation.test.ts",
];
