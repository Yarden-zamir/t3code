/**
 * Fork: upstream browser test files that fork test runs skip, each with its reason.
 * `vite.config.ts` excludes them from the browser project. Remove an entry when its reason is gone.
 */
export const FORK_EXCLUDED_UPSTREAM_BROWSER_TESTS = [
  // Office, PDF and notebook previews render in workers and need upstream's 8-vCPU runners: on
  // Fork CI's 4-vCPU runner they pass their 15 s limits only alone. The fork does not change the
  // preview code. Remove this when Fork CI runs web tests on a larger runner.
  "src/components/files/AttachmentFilePreview.browser.test.tsx",
];
