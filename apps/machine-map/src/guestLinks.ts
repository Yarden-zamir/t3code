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

const isDigits = (text: string): boolean =>
  text !== "" && [...text].every((c) => c >= "0" && c <= "9");

/** The four numbers of an IPv4 address, or null. */
const ipv4Parts = (address: string): Array<number> | null => {
  const parts = address.split(".");
  return parts.length === 4 && parts.every((p) => isDigits(p) && Number(p) <= 255)
    ? parts.map(Number)
    : null;
};

const HEX = "0123456789abcdef";
const ipv6Valid = (address: string): boolean => {
  const halves = address.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half === "" ? [] : half.split(":")));
  const groupsOk = groups.every(
    (g) => g.length >= 1 && g.length <= 4 && [...g].every((c) => HEX.includes(c)),
  );
  return groupsOk && (halves.length === 2 ? groups.length <= 7 : groups.length === 8);
};

/**
 * An IPv4 or IPv6 range in CIDR form, as Cloudflare stores it: an IPv4 range starts at its network
 * address, and a bare address is a range of one address. Limit: an IPv6 range keeps its address
 * as given, in lower case. Revisit if Cloudflare reports such a range in another form.
 */
function ipRange(text: string): string | null {
  const [rawAddress = "", prefix, extra] = text.split("/");
  const address = rawAddress.toLowerCase();
  if (extra !== undefined) return null;
  const v4 = ipv4Parts(address);
  if (v4 === null && !ipv6Valid(address)) return null;
  const max = v4 === null ? 128 : 32;
  if (prefix !== undefined && (!isDigits(prefix) || Number(prefix) > max)) return null;
  const bits = prefix === undefined ? max : Number(prefix);
  if (v4 === null) return `${address}/${bits}`;
  const value = v4.reduce((total, part) => total * 256 + part, 0);
  const size = 2 ** (32 - bits);
  const network = Math.floor(value / size) * size;
  const parts = [24, 16, 8, 0].map((shift) => Math.floor(network / 2 ** shift) % 256);
  return `${parts.join(".")}/${bits}`;
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
  const normalized = {
    emails,
    emailDomains,
    ipRanges: valid(rules.ipRanges),
    requireIpRanges: valid(rules.requireIpRanges),
  };
  if (
    normalized.requireIpRanges.length > 0 &&
    emails.length + emailDomains.length + normalized.ipRanges.length === 0
  )
    return { error: "Required IP ranges need at least one email, email domain or IP range." };
  return { rules: normalized };
}

/**
 * The policies of a guest app. The owners have their own policy, because Access applies the
 * `require` rules of a policy to each of its include rules.
 */
export function guestPolicies(rules: GuestRules, owners: ReadonlyArray<string>) {
  if (owners.length === 0) throw new Error("Set OWNER_EMAILS in wrangler.jsonc first.");
  const guests = [
    ...rules.emails.map((email) => ({ email: { email } })),
    ...rules.emailDomains.map((domain) => ({ email_domain: { domain } })),
    ...rules.ipRanges.map((ip) => ({ ip: { ip } })),
  ];
  const ownerPolicy = {
    name: "t3 owner",
    decision: "allow",
    include: owners.map((email) => ({ email: { email } })),
    require: [] as Array<{ ip: { ip: string } }>,
  };
  if (guests.length === 0) return [ownerPolicy];
  const require = rules.requireIpRanges.map((ip) => ({ ip: { ip } }));
  return [ownerPolicy, { name: "t3 guests", decision: "allow", include: guests, require }];
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
  policies: ReturnType<typeof guestPolicies>,
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
    policies,
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
  const shape = (policy: {
    readonly decision: string;
    readonly include: ReadonlyArray<unknown>;
    readonly require?: ReadonlyArray<unknown> | null | undefined;
    readonly exclude?: ReadonlyArray<unknown> | null | undefined;
  }) => ({
    decision: policy.decision,
    include: policy.include.map((rule) => JSON.stringify(rule)).toSorted(),
    require: (policy.require ?? []).map((rule) => JSON.stringify(rule)).toSorted(),
    exclude: (policy.exclude ?? []).length,
  });
  if (!sameSet((app.policies ?? []).map(shape), body.policies.map(shape)))
    return `The app "${app.name}" has other rules.`;
  return null;
}

/**
 * Why the portal must not make guest apps on the host that a machine reported, or null. A machine
 * reports its own hostname, so the portal accepts only a plain name in the zone of the machine
 * hostnames, not the portal host and not the host of another machine.
 */
export function guestHostProblem(
  hostname: string,
  machineDomain: string | undefined,
  portalHost: string,
  otherHostnames: ReadonlyArray<string>,
): string | null {
  if (machineDomain === undefined || machineDomain === "")
    return "Set MACHINE_DOMAIN in wrangler.jsonc first.";
  const name = hostname.toLowerCase();
  const labels = name.split(".");
  const plain = labels.every(
    (label) =>
      label !== "" &&
      !label.startsWith("-") &&
      [...label].every((c) => c === "-" || (c >= "a" && c <= "z") || (c >= "0" && c <= "9")),
  );
  if (!plain || !name.endsWith(`.${machineDomain.toLowerCase()}`))
    return `The reported host ${hostname} is not a plain name in ${machineDomain}.`;
  if (name === portalHost.toLowerCase()) return `The reported host ${hostname} is the portal host.`;
  if (otherHostnames.some((other) => other.toLowerCase() === name))
    return `Another machine reports the host ${hostname} too.`;
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
