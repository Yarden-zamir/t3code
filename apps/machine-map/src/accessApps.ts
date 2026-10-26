/**
 * MM-1216: the Access apps of the portal itself, found by what they cover. The Durable Object
 * stores the id and the audience of each app, and the Worker checks the audiences (MM-1217).
 */
import * as Schema from "effect/Schema";

import { appHosts, normalHost, ownerPolicy, type GuestApp } from "./cloudflare.ts";

export const ACCESS_PARTS = ["pages", "connect", "enroll", "machines"] as const;
export type AccessPart = (typeof ACCESS_PARTS)[number];

const AppRef = Schema.Struct({ id: Schema.String, aud: Schema.String });
export type AppRef = typeof AppRef.Type;

/** The stored apps. They apply only to requests on `host`. */
export const StoredAccessApps = Schema.Struct({
  host: Schema.String,
  apps: Schema.Struct({
    pages: Schema.optionalKey(AppRef),
    connect: Schema.optionalKey(AppRef),
    enroll: Schema.optionalKey(AppRef),
    machines: Schema.optionalKey(AppRef),
  }),
});
export type StoredAccessApps = typeof StoredAccessApps.Type;

export const ACCESS_PART_LABEL: Record<AccessPart, string> = {
  pages: "Portal pages",
  connect: "Machine connections",
  enroll: "Enrollment",
  machines: "Machine hostnames",
};

/** The hostname of every machine tunnel: one `t3-<name>` label under the machine domain. */
export const machineHostsUri = (machineDomain: string): string => `t3-*.${machineDomain}`;

/** What the app of a portal path covers: the host itself, `/connect` or `/enroll`. */
export function partUri(part: Exclude<AccessPart, "machines">, host: string): string {
  switch (part) {
    case "pages":
      return host;
    case "connect":
      return `${host}/connect`;
    case "enroll":
      return `${host}/enroll`;
  }
}

/** Where to look for the machine hostnames app, strongest sign first. */
export interface MachineHosts {
  readonly machineDomain: string | null;
  /** Tunnel hostnames that the portal added to the app (MM-213). */
  readonly added: ReadonlyArray<string>;
  /** Hostnames that the machines report (MM-209). */
  readonly reported: ReadonlyArray<string>;
}

export type Discovery =
  | { readonly _tag: "found"; readonly app: GuestApp }
  | { readonly _tag: "none"; readonly reason: string }
  /** More than one app fits. The portal never picks one, so it fails closed. */
  | { readonly _tag: "many"; readonly reason: string };

const covering = (apps: ReadonlyArray<GuestApp>, uris: ReadonlyArray<string>) => {
  const wanted = new Set(uris.map(normalHost));
  return apps.filter(
    (app) => app.type === "self_hosted" && appHosts(app).some((uri) => wanted.has(uri)),
  );
};

const pick = (apps: ReadonlyArray<GuestApp>, what: string): Discovery | null => {
  const [first, ...rest] = apps;
  if (first === undefined) return null;
  if (rest.length === 0) return { _tag: "found", app: first };
  const names = apps.map((app) => `"${app.name}"`).join(", ");
  return {
    _tag: "many",
    reason: `${apps.length} Access apps cover ${what}: ${names}. Keep one and delete the others in the Zero Trust dashboard.`,
  };
};

/**
 * Finds the app of a part among every Access app of the account. A path app must cover exactly its
 * path on the portal host. The machine hostnames app covers `t3-*.<machine domain>`, or else the
 * tunnel hostnames that the portal added, or else the hostnames that the machines report.
 */
export function discoverAccessApp(
  apps: ReadonlyArray<GuestApp>,
  part: AccessPart,
  host: string,
  machines: MachineHosts,
): Discovery {
  if (part !== "machines") {
    const uri = partUri(part, host);
    return (
      pick(covering(apps, [uri]), uri) ?? { _tag: "none", reason: `No Access app covers ${uri}.` }
    );
  }
  const steps: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
    [
      machines.machineDomain === null ? [] : [machineHostsUri(machines.machineDomain)],
      "the machine hostnames",
    ],
    [machines.added, "the machine tunnel hostnames"],
    [machines.reported, "the machine hostnames"],
  ];
  for (const [uris, what] of steps) {
    const found = uris.length === 0 ? null : pick(covering(apps, uris), what);
    if (found !== null) return found;
  }
  return {
    _tag: "none",
    reason:
      machines.machineDomain === null
        ? "Set MACHINE_DOMAIN in wrangler.jsonc first."
        : `No Access app covers ${machineHostsUri(machines.machineDomain)}.`,
  };
}

/**
 * A stored app still counts when it exists and, for a path app, still covers its path. The portal
 * never swaps a stored app for another app while the stored one still counts.
 */
export function storedAppHolds(app: GuestApp | undefined, part: AccessPart, host: string): boolean {
  if (app === undefined || app.type !== "self_hosted") return false;
  return part === "machines" || appHosts(app).includes(normalHost(partUri(part, host)));
}

/** A hostname under `t3-*.<domain>`: one label that starts with `t3-`. */
export const underMachineWildcard = (hostname: string, machineDomain: string): boolean => {
  const suffix = `.${machineDomain.toLowerCase()}`;
  const name = hostname.toLowerCase();
  if (!name.endsWith(suffix)) return false;
  const label = name.slice(0, -suffix.length);
  return label.startsWith("t3-") && !label.includes(".");
};

/** The machine hostnames app covers a tunnel hostname, by name or by its wildcard. */
export function coversMachineHost(
  app: GuestApp,
  hostname: string,
  machineDomain: string | null,
): boolean {
  const hosts = appHosts(app);
  if (hosts.includes(normalHost(hostname))) return true;
  return (
    machineDomain !== null &&
    hosts.includes(normalHost(machineHostsUri(machineDomain))) &&
    underMachineWildcard(hostname, machineDomain)
  );
}

/** The body of an app that Repair makes (MM-1219). The portal pages app is the setup script's. */
export function accessAppBody(
  part: Exclude<AccessPart, "pages">,
  host: string,
  machineDomain: string,
  owners: ReadonlyArray<string>,
): Record<string, unknown> {
  const uri = part === "machines" ? machineHostsUri(machineDomain) : partUri(part, host);
  const base = {
    type: "self_hosted",
    domain: uri,
    destinations: [{ type: "public", uri }],
    app_launcher_visible: false,
  };
  switch (part) {
    // The portal adds the policy of the machine tokens (MM-201). Until then, no one gets in.
    case "connect":
      return { ...base, name: "t3 portal connect" };
    // The join code is the credential (MM-204). This app also covers `/enroll/client` (MM-913).
    case "enroll":
      return {
        ...base,
        name: "t3 portal enroll",
        policies: [{ name: "t3 join codes", decision: "bypass", include: [{ everyone: {} }] }],
      };
    case "machines":
      return {
        ...base,
        name: "t3 machine hosts",
        session_duration: "720h",
        policies: [ownerPolicy(owners)],
      };
  }
}

/** The app lets everyone in with a Bypass policy, as `/enroll` needs. */
export const bypassesEveryone = (app: GuestApp): boolean =>
  (app.policies ?? []).some(
    (policy) =>
      policy.decision === "bypass" &&
      policy.include.some((rule) => JSON.stringify(rule) === JSON.stringify({ everyone: {} })),
  );
