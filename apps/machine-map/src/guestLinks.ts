/**
 * MM-1210: the Cloudflare setup of guest links on each machine host, as plain data. The Durable
 * Object compares what Cloudflare holds with these shapes and makes Cloudflare match them.
 * docs/fork/operations.md, "Guest links through Cloudflare Access", explains each part.
 */
import type {
  MachineMapDocument,
  MachineId,
  ScopedSettingValues,
} from "@t3tools/contracts/machineMap";

import type { GuestRules } from "./api.ts";
import type { GuestApp } from "./cloudflare.ts";
import { effectiveSettings } from "./rules/map.ts";

/** The server setting that turns guest links on. */
export const GUEST_SETTING = "guestSharingEnabled";

/** The guest page and its routes. They need a guest login. */
export const GUEST_PATHS = ["guest", "api/guest/*"];
/**
 * The public web build files that the guest page loads. A script cannot follow a redirect to the
 * Access login, so they need a Bypass app. The owner page loads the same files.
 */
export const GUEST_BUILD_PATHS = [
  "assets/*",
  "apple-touch-icon.png",
  "favicon.ico",
  "manifest.webmanifest",
];
/** The life of a guest link. */
export const GUEST_SESSION = "24h";

export type GuestAppKind = "guest" | "build";

export const guestAppName = (kind: GuestAppKind, hostname: string): string =>
  kind === "guest" ? `t3 guest links ${hostname}` : `t3 web build ${hostname}`;

const guestAppPaths = (kind: GuestAppKind): ReadonlyArray<string> =>
  kind === "guest" ? GUEST_PATHS : GUEST_BUILD_PATHS;

export const EMPTY_GUEST_RULES: GuestRules = {
  emails: [],
  emailDomains: [],
  ipRanges: [],
  requireIpRanges: [],
};

/** MM-1210: the rule of the zone that limits the guest routes. The `ref` finds it again. */
export const GUEST_RATE_LIMIT_RULE = {
  ref: "t3_guest_routes",
  description: "T3 guest routes (machine map portal)",
  // The Free plan allows only the path in this expression, period 10 and timeout 10.
  expression: 'starts_with(http.request.uri.path, "/api/guest/")',
  action: "block",
  enabled: true,
  ratelimit: {
    characteristics: ["cf.colo.id", "ip.src"],
    period: 10,
    requests_per_period: 100,
    mitigation_timeout: 10,
  },
} as const;

/**
 * Whether guest links are on for a machine: the map value when the map holds one, otherwise the
 * value that the machine reported.
 */
export function guestLinksOn(
  map: MachineMapDocument,
  reported: ScopedSettingValues,
  machineId: MachineId,
): boolean {
  const server = effectiveSettings(map, machineId).server;
  return Object.hasOwn(server, GUEST_SETTING)
    ? server[GUEST_SETTING] === true
    : reported.server[GUEST_SETTING] === true;
}

const unique = (values: ReadonlyArray<string>): Array<string> => [...new Set(values)];

const ipv4Valid = (address: string): boolean => {
  const parts = address.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) => part !== "" && [...part].every((c) => c >= "0" && c <= "9") && Number(part) <= 255,
    )
  );
};

const HEX = "0123456789abcdef";
const ipv6Valid = (address: string): boolean =>
  address.includes(":") && [...address.toLowerCase()].every((c) => c === ":" || HEX.includes(c));

/** An IPv4 or IPv6 range in CIDR form. A bare address becomes a range of one address. */
function ipRange(text: string): string | null {
  const [address = "", prefix, extra] = text.split("/");
  if (extra !== undefined) return null;
  const v4 = ipv4Valid(address);
  if (!v4 && !ipv6Valid(address)) return null;
  const max = v4 ? 32 : 128;
  if (prefix === undefined) return `${address}/${max}`;
  const bits = Number(prefix);
  return prefix !== "" && Number.isInteger(bits) && bits >= 0 && bits <= max ? text : null;
}

/** The rules in a stable form, or the first entry that Cloudflare would refuse. */
export function normalizeGuestRules(
  rules: GuestRules,
): { readonly rules: GuestRules } | { readonly error: string } {
  const emails = unique(rules.emails.map((e) => e.trim().toLowerCase()));
  const badEmail = emails.find((e) => {
    const at = e.indexOf("@");
    return at < 1 || at !== e.lastIndexOf("@") || !e.slice(at + 1).includes(".") || e.includes(" ");
  });
  if (badEmail !== undefined) return { error: `"${badEmail}" is not an email.` };
  const emailDomains = unique(
    rules.emailDomains.map((d) => {
      const domain = d.trim().toLowerCase();
      return domain.startsWith("@") ? domain.slice(1) : domain;
    }),
  );
  const badDomain = emailDomains.find(
    (d) => !d.includes(".") || d.includes("@") || d.includes(" "),
  );
  if (badDomain !== undefined) return { error: `"${badDomain}" is not an email domain.` };
  const ranges = (values: ReadonlyArray<string>) =>
    values.map((v) => ({ text: v, range: ipRange(v.trim()) }));
  const allRanges = [...ranges(rules.ipRanges), ...ranges(rules.requireIpRanges)];
  const badRange = allRanges.find((r) => r.range === null);
  if (badRange !== undefined)
    return { error: `"${badRange.text}" is not an IP range, for example 10.0.0.0/8.` };
  const valid = (values: ReadonlyArray<string>) =>
    unique(
      values.flatMap((v) => {
        const range = ipRange(v.trim());
        return range === null ? [] : [range];
      }),
    );
  return {
    rules: {
      emails,
      emailDomains,
      ipRanges: valid(rules.ipRanges),
      requireIpRanges: valid(rules.requireIpRanges),
    },
  };
}

/** The policy of a guest app: the owner emails and the rules include, the required ranges require. */
export function guestPolicy(rules: GuestRules, owners: ReadonlyArray<string>) {
  return {
    name: "t3 guests",
    decision: "allow",
    include: [
      ...unique([...owners, ...rules.emails]).map((email) => ({ email: { email } })),
      ...rules.emailDomains.map((domain) => ({ email_domain: { domain } })),
      ...rules.ipRanges.map((ip) => ({ ip: { ip } })),
    ],
    require: rules.requireIpRanges.map((ip) => ({ ip: { ip } })),
  };
}

const BUILD_POLICY = {
  name: "t3 web build",
  decision: "bypass",
  include: [{ everyone: {} }],
  require: [],
};

/**
 * The POST body of a guest app or a build app. The guest app takes only One-time PIN, so a guest
 * never sees the login of the owner. The build app needs no login.
 */
export function guestAppBody(
  kind: GuestAppKind,
  hostname: string,
  policy: ReturnType<typeof guestPolicy>,
  oneTimePinId: string,
) {
  const uris = guestAppPaths(kind).map((path) => `${hostname}/${path}`);
  const common = {
    type: "self_hosted",
    name: guestAppName(kind, hostname),
    domain: uris[0],
    destinations: uris.map((uri) => ({ type: "public", uri })),
    app_launcher_visible: false,
  };
  if (kind === "build") return { ...common, policies: [BUILD_POLICY] };
  return {
    ...common,
    session_duration: GUEST_SESSION,
    allowed_idps: [oneTimePinId],
    auto_redirect_to_identity: true,
    policies: [policy],
  };
}

const sameSet = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean => {
  const left = new Set(a.map((item) => JSON.stringify(item)));
  const right = new Set(b.map((item) => JSON.stringify(item)));
  return left.size === right.size && [...left].every((item) => right.has(item));
};

/** Why a guest or build app differs from the body the portal would send, or null. */
export function guestAppProblem(
  app: GuestApp,
  body: ReturnType<typeof guestAppBody>,
): string | null {
  const uris = (app.destinations ?? []).map((d) => d.uri);
  if (
    !sameSet(
      uris,
      body.destinations.map((d) => d.uri),
    )
  )
    return `The app "${app.name}" covers other paths.`;
  if ("allowed_idps" in body) {
    if (app.session_duration !== body.session_duration)
      return `The app "${app.name}" has another session duration.`;
    if (!sameSet(app.allowed_idps ?? [], body.allowed_idps))
      return `The app "${app.name}" allows another login method.`;
  }
  const policies = app.policies ?? [];
  const [wanted] = body.policies;
  const [policy] = policies;
  if (
    policies.length !== 1 ||
    policy === undefined ||
    wanted === undefined ||
    policy.decision !== wanted.decision ||
    !sameSet(policy.include, wanted.include) ||
    !sameSet(policy.require ?? [], wanted.require) ||
    (policy.exclude ?? []).length > 0
  )
    return `The app "${app.name}" has other rules.`;
  return null;
}

/**
 * An Access app that the portal did not make and that covers one of the paths of `kind` on the
 * host. Cloudflare uses the app with the most specific path, so the portal does not add a twin.
 */
export function foreignGuestApp(
  apps: ReadonlyArray<GuestApp>,
  kind: GuestAppKind,
  hostname: string,
): GuestApp | null {
  const uris = new Set(guestAppPaths(kind).map((path) => `${hostname}/${path}`));
  const name = guestAppName(kind, hostname);
  return (
    apps.find(
      (app) =>
        app.name !== name &&
        (app.destinations ?? []).some((d) => d.uri !== undefined && uris.has(d.uri)),
    ) ?? null
  );
}

/** Why the guest rate limit rule differs from the one the portal makes, or null. */
export function guestRateLimitProblem(rule: {
  readonly expression?: string | undefined;
  readonly action?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly ratelimit?:
    | {
        readonly period?: number | undefined;
        readonly requests_per_period?: number | undefined;
        readonly mitigation_timeout?: number | undefined;
      }
    | undefined;
}): string | null {
  const wanted = GUEST_RATE_LIMIT_RULE;
  const same =
    rule.expression === wanted.expression &&
    rule.action === wanted.action &&
    rule.enabled !== false &&
    rule.ratelimit?.period === wanted.ratelimit.period &&
    rule.ratelimit?.requests_per_period === wanted.ratelimit.requests_per_period &&
    rule.ratelimit?.mitigation_timeout === wanted.ratelimit.mitigation_timeout;
  return same ? null : "The rate limit rule of the guest routes changed.";
}
