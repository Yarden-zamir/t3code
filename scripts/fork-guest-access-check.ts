#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off - plain Node script.
// Fork: checks the Cloudflare Access setup for guest links on a tunnel host.
// See docs/fork/operations.md#guest-links-through-cloudflare-access.
//
//   node scripts/fork-guest-access-check.ts https://t3-vps.yarden-zamir.com
//
// Without credentials, the public web build files must be open (a Bypass app), and every other
// path must stop at Cloudflare Access: the owner paths at the owner app, the guest paths at the
// guest app.
//
// Set `T3_GUEST_ACCESS_COOKIE` to the value of the `CF_Authorization` cookie of a guest login (not
// the owner's) to also check that the guest app opens only the guest paths, and that the server
// refuses guest routes without a guest link.

import * as NodeProcess from "node:process";

type Seen = "access" | "server-guest-refusal" | "open";

interface Check {
  readonly path: string;
  readonly cookie: boolean;
  readonly want: Seen;
  readonly why: string;
}

const OWNER_PATHS = ["/", "/settings", "/api/auth/session", "/ws", "/.well-known/t3/environment"];
// A missing asset name still shows whether `/assets/*` passes Access: the server answers it itself.
const BUILD_PATHS = [
  "/assets/check.js",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/apple-touch-icon.png",
];
const GUEST_API_PATHS = [
  "/api/guest/session?share=check",
  "/api/guest/stream?share=check",
  "/api/guest/tool-output-image?share=check&item=check&index=0",
];

/** Access answers with a redirect to its login, or with its own 401 or 403. */
async function classify(response: Response): Promise<Seen> {
  const location = response.headers.get("location") ?? "";
  if (
    response.status >= 300 &&
    response.status < 400 &&
    (location.includes(".cloudflareaccess.com") || location.includes("/cdn-cgi/access/"))
  ) {
    return "access";
  }
  if (response.status === 401 || response.status === 403) {
    const body = await response.text();
    // The guest routes refuse with JSON that names a `reason`; see apps/server/src/guest/http.ts.
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && "reason" in parsed) {
        return "server-guest-refusal";
      }
    } catch {
      // Not JSON: an Access block page.
    }
    return "access";
  }
  return "open";
}

const [origin] = NodeProcess.argv.slice(2);
if (origin === undefined || !URL.canParse(origin)) {
  console.error("Usage: node scripts/fork-guest-access-check.ts <https origin>");
  NodeProcess.exit(2);
}
const guestCookie = NodeProcess.env.T3_GUEST_ACCESS_COOKIE;

const checks: ReadonlyArray<Check> = [
  ...BUILD_PATHS.map((path) => ({
    path,
    cookie: false,
    want: "open" as const,
    why: "no login, public build file",
  })),
  ...[...OWNER_PATHS, "/guest", ...GUEST_API_PATHS].map((path) => ({
    path,
    cookie: false,
    want: "access" as const,
    why: "no login",
  })),
  ...(guestCookie === undefined
    ? []
    : [
        ...OWNER_PATHS.map((path) => ({
          path,
          cookie: true,
          want: "access" as const,
          why: "guest login, owner path",
        })),
        ...GUEST_API_PATHS.map((path) => ({
          path,
          cookie: true,
          want: "server-guest-refusal" as const,
          why: "guest login, no guest link",
        })),
      ]),
];

let failed = 0;
const rows: Array<Record<string, string>> = [];
for (const check of checks) {
  const response = await fetch(new URL(check.path, origin), {
    redirect: "manual",
    headers: check.cookie ? { cookie: `CF_Authorization=${guestCookie}` } : {},
  });
  const seen = await classify(response);
  const pass = seen === check.want;
  if (!pass) failed += 1;
  rows.push({
    result: pass ? "pass" : "FAIL",
    path: check.path,
    case: check.why,
    want: check.want,
    seen: `${seen} (${response.status})`,
  });
}
console.table(rows);
if (guestCookie === undefined) {
  console.log("Skipped the guest login checks. Set T3_GUEST_ACCESS_COOKIE to run them.");
}
console.log(failed === 0 ? "All checks passed." : `${failed} checks failed.`);
NodeProcess.exit(failed === 0 ? 0 : 1);
