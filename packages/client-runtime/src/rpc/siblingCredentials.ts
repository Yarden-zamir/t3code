// Fork: cookies for sibling environments behind a proxy such as Cloudflare Access, which redirects
// a request without its cookie to a login. The browser sends only cookies that it holds for the
// target, and the target must list the page origin (T3CODE_TRUSTED_BROWSER_ORIGINS). The page
// server must also list the target, so cookies stay off until the user opts in on the servers.

// Origins that the page's own server trusts (`trustedBrowserOrigins`), empty until config loads.
// Limit: a remote request before then goes without cookies and fails once; the retry succeeds.
// Revisit when that first failure shows in the UI.
let trustedOrigins: ReadonlySet<string> = new Set();

/** Set from the page's primary server config. An empty list turns cookies off. */
export const setCredentialedSiblingOrigins = (origins: ReadonlyArray<string>): void => {
  trustedOrigins = new Set(origins);
};

interface PageLocation {
  readonly protocol: string;
  readonly hostname: string;
}

/**
 * Whether `url` is an https sibling of the page: both https and the last two hostname labels match
 * (`t3-vps.example.com` and `t3-mac.example.com`). Limit: all hosts under a multi-part suffix such
 * as `co.uk` count as siblings. Revisit with a public suffix list when a user runs environments
 * under such a suffix.
 */
export const isSiblingOfPage = (url: string, page: PageLocation | undefined): boolean => {
  if (page === undefined || page.protocol !== "https:") return false;
  const target = URL.parse(url);
  if (target === null || target.protocol !== "https:") return false;
  const domain = registrableDomain(target.hostname);
  return domain !== null && domain === registrableDomain(page.hostname);
};

const registrableDomain = (hostname: string): string | null => {
  const labels = hostname.toLowerCase().split(".");
  return labels.length < 2 ? null : labels.slice(-2).join(".");
};

/** Whether a request to `url` sends cookies: only to a trusted sibling of the page. */
export const sendsSiblingCredentials = (
  url: string,
  page: PageLocation | undefined = globalThis.location,
): boolean => {
  const origin = URL.parse(url)?.origin;
  return origin !== undefined && trustedOrigins.has(origin) && isSiblingOfPage(url, page);
};
