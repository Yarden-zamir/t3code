/**
 * Dev-only fixture mode: `?fixture=1` loads the page from `dev/fixture.json` instead of the
 * portal, and keeps every write in memory. `import.meta.env.DEV` is false in a build, so the
 * fixture code behind this flag never ships, and the file is not in the build either.
 */
const search = (): URLSearchParams =>
  // Tests import the store without a page, so there is no `location` there.
  new URLSearchParams(typeof location === "undefined" ? "" : location.search);

export const FIXTURE_MODE: boolean = import.meta.env.DEV && search().has("fixture");

/** `?fixture=1&demo=1` adds one pending proposal and one temporary arrow to the fixture. */
export const FIXTURE_DEMO: boolean = FIXTURE_MODE && search().has("demo");
