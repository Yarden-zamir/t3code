#!/usr/bin/env node
// MM-1215: the first-time setup of the portal. README "First-time setup" has the usage. Each run
// changes only what differs, and it never deploys: the workflow does that from main.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";

import { CloudflareApi, isPermissionRefusal, type GuestApp } from "../src/cloudflare.ts";
import { isSet, readRouteHost, readVars, writeRoute, writeVar } from "./wranglerConfig.ts";

const WRANGLER_CONFIG = NodePath.join(import.meta.dirname, "..", "wrangler.jsonc");
const WRANGLER = NodePath.join(import.meta.dirname, "..", "node_modules", ".bin", "wrangler");
const SECRETS_LATER =
  'The Worker does not exist yet. Merge wrangler.jsonc to main, wait for the workflow "Machine map deploy", then run this again.';

/** The permissions of the portal token, as keys of the dashboard token template. */
const PORTAL_TOKEN_KEYS = [
  { key: "access", type: "edit" },
  { key: "access_acct", type: "edit" },
  { key: "access_acct", type: "revoke" },
  { key: "argotunnel", type: "edit" },
  { key: "dns", type: "edit" },
  { key: "zone_waf", type: "edit" },
];
const DEPLOY_TOKEN_KEYS = [
  { key: "workers_scripts", type: "edit" },
  { key: "workers_routes", type: "edit" },
];

const tokenLink = (keys: ReadonlyArray<{ key: string; type: string }>, name: string) =>
  `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}&accountId=*&zoneId=all&name=${encodeURIComponent(name)}`;

function printLinks(): void {
  console.log(
    `Portal token (the CF_API_TOKEN secret):\n  ${tokenLink(PORTAL_TOKEN_KEYS, "T3 machine map portal")}`,
  );
  console.log(`  Add "Access: Service Tokens Edit" by hand: the template has no key for it.`);
  console.log(
    `Deploy token (the GitHub secret CLOUDFLARE_DEPLOY_TOKEN):\n  ${tokenLink(DEPLOY_TOKEN_KEYS, "T3 machine map deploy")}`,
  );
}

// Access apps: found by their hostnames, so the apps of a setup by hand count too.

const uris = (app: GuestApp) => (app.destinations ?? []).flatMap((d) => (d.uri ? [d.uri] : []));

async function ensureApp(
  api: CloudflareApi,
  apps: ReadonlyArray<GuestApp>,
  label: string,
  uri: string,
  body: Record<string, unknown>,
): Promise<{ readonly id: string; readonly aud: string }> {
  const found = apps.find((app) => uris(app).includes(uri));
  if (found) {
    console.log(`ok       ${label}: the app "${found.name}" covers ${uri}`);
    return { id: found.id, aud: await api.accessAppAud(found.id) };
  }
  const id = await api.createAccessApp({
    type: "self_hosted",
    domain: uri,
    destinations: [{ type: "public", uri }],
    app_launcher_visible: false,
    ...body,
  });
  console.log(`created  ${label}: ${uri}`);
  return { id, aud: await api.accessAppAud(id) };
}

// Secrets go through the owner's `wrangler login`, never through the portal token.

function wrangler(args: ReadonlyArray<string>, input?: string): { ok: boolean; out: string } {
  const env = { ...NodeProcess.env };
  delete env.CF_API_TOKEN;
  delete env.CLOUDFLARE_API_TOKEN;
  const result = NodeChildProcess.spawnSync(WRANGLER, args, {
    cwd: NodePath.dirname(WRANGLER_CONFIG),
    env,
    input,
    encoding: "utf8",
  });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}` };
}

function workerSecrets(): ReadonlySet<string> | null {
  const listed = wrangler(["secret", "list", "--format", "json"]);
  if (!listed.ok) return null;
  const parsed: unknown = JSON.parse(listed.out.slice(listed.out.indexOf("[")));
  if (!Array.isArray(parsed)) throw new Error("wrangler secret list gave no list.");
  return new Set(
    parsed.flatMap((entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "name" in entry &&
      typeof entry.name === "string"
        ? [entry.name]
        : [],
    ),
  );
}

function putSecret(name: string, value: string): void {
  const put = wrangler(["secret", "put", name], value);
  if (!put.ok) throw new Error(`wrangler secret put ${name} failed: ${put.out}`);
  console.log(`set      secret ${name}`);
}

const newVapidKey = () =>
  JSON.stringify(
    NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
      format: "jwk",
    }),
  );

// The final check: what each token can read, and what a visitor without a login meets.

async function probe(label: string, permission: string, run: () => Promise<unknown>) {
  try {
    await run();
    console.log(`ok       ${label}`);
    return true;
  } catch (error) {
    if (!isPermissionRefusal(error)) throw error;
    console.log(`missing  ${label}: add "${permission}" to the portal token`);
    return false;
  }
}

async function visit(host: string, path: string, method = "GET"): Promise<"access" | "worker"> {
  const response = await fetch(`https://${host}${path}`, {
    method,
    redirect: "manual",
    ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
  });
  const location = response.headers.get("location") ?? "";
  return location.includes(".cloudflareaccess.com") ||
    location.includes("/cdn-cgi/access/") ||
    response.status === 403
    ? "access"
    : "worker";
}

async function check(api: CloudflareApi, host: string, zoneId: string): Promise<boolean> {
  console.log("\nCheck (read access only; a read does not prove edit access):");
  const results = [
    await probe("Access service tokens", "Access: Service Tokens Edit", () =>
      api.findServiceTokenId("permission-check"),
    ),
    await probe("Access apps", "Access: Apps and Policies Edit", () => api.accessApps()),
    await probe(
      "Zero Trust organization and login methods",
      "Access: Organizations, Identity Providers, and Groups Edit",
      () => api.oneTimePinId(),
    ),
    await probe("Cloudflare Tunnel", "Cloudflare Tunnel: Edit", () =>
      api.findTunnelByName("permission-check"),
    ),
    await probe("DNS", "DNS: Edit", () => api.findDnsRecord(zoneId, host)),
    await probe("Zone WAF", "Zone WAF Edit", () => api.guestRateLimit(zoneId)),
  ];
  const revoke = await api.canRevokeSessions();
  console.log(
    revoke
      ? "ok       Access session revoke"
      : 'missing  Access session revoke: add "Access: Organizations Revoke"',
  );
  const paths: ReadonlyArray<readonly [string, string, "access" | "worker"]> = [
    ["/", "GET", "access"],
    ["/api/history", "GET", "access"],
    ["/connect", "GET", "access"],
    ["/enroll", "POST", "worker"],
  ];
  for (const [path, method, want] of paths) {
    const seen = await visit(host, path, method).catch(() => "unreachable" as const);
    results.push(seen === want);
    console.log(
      `${seen === want ? "ok      " : "wrong   "} ${method} ${path} without a login: ${seen}, want ${want}`,
    );
  }
  return results.every(Boolean) && revoke;
}

async function main(): Promise<number> {
  const { values, positionals } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      host: { type: "string" },
      "owner-email": { type: "string", multiple: true },
      "machine-domain": { type: "string" },
      "replace-token": { type: "boolean", default: false },
    },
  });
  if (positionals[0] === "links") {
    printLinks();
    return 0;
  }
  const token = NodeProcess.env.CF_API_TOKEN;
  if (!token) {
    console.error(
      "Set CF_API_TOKEN to the portal token. Run `node scripts/setup.ts links` to make one.",
    );
    return 2;
  }
  let config = NodeFS.readFileSync(WRANGLER_CONFIG, "utf8");
  const vars = readVars(config);
  const routeHost = readRouteHost(config);
  const host = values.host ?? routeHost;
  const machineDomain = values["machine-domain"] ?? vars.get("MACHINE_DOMAIN");
  const owners =
    values["owner-email"] ??
    vars
      .get("OWNER_EMAILS")
      ?.split(",")
      .map((e) => e.trim());
  if (!isSet(host) || !isSet(machineDomain) || !owners?.every(isSet)) {
    console.error(
      "Give --host, --machine-domain and --owner-email, or set them in wrangler.jsonc.",
    );
    return 2;
  }

  let accountId = vars.get("ACCOUNT_ID");
  if (!isSet(accountId)) {
    const accounts = await new CloudflareApi(token, "").accounts();
    const [only] = accounts;
    if (accounts.length !== 1 || only === undefined) {
      console.error(
        `The token sees ${accounts.length} accounts. Set ACCOUNT_ID in wrangler.jsonc.`,
      );
      return 2;
    }
    accountId = only.id;
  }
  const api = new CloudflareApi(token, accountId);
  const zoneId = await api.zoneId(machineDomain);
  if (zoneId === null) {
    console.error(`The token cannot see the zone ${machineDomain}. Add "DNS: Edit" for it.`);
    return 2;
  }
  const ownerPolicy = {
    name: "t3 owner",
    decision: "allow",
    include: owners.map((email) => ({ email: { email } })),
  };
  const apps = await api.accessApps();
  const pages = await ensureApp(api, apps, "portal pages", host, {
    name: "t3 portal pages",
    session_duration: "720h",
    policies: [ownerPolicy],
  });
  // The portal adds the policy of the machine tokens (MM-201). Until then, the app lets no one in.
  const connect = await ensureApp(api, apps, "machine connections", `${host}/connect`, {
    name: "t3 portal connect",
  });
  await ensureApp(api, apps, "enrollment", `${host}/enroll`, {
    name: "t3 portal enroll",
    policies: [{ name: "t3 join codes", decision: "bypass", include: [{ everyone: {} }] }],
  });
  const existingMachines = vars.get("MACHINE_ACCESS_APP_ID");
  const machines = isSet(existingMachines)
    ? { id: existingMachines }
    : await ensureApp(api, apps, "machine hostnames", `t3-*.${machineDomain}`, {
        name: "t3 machine hosts",
        session_duration: "720h",
        policies: [ownerPolicy],
      });

  const wanted: ReadonlyArray<readonly [string, string]> = [
    ["ACCOUNT_ID", accountId],
    ["TEAM_DOMAIN", await api.teamDomain()],
    ["OWNER_EMAILS", owners.join(",")],
    ["MACHINE_ACCESS_APP_ID", machines.id],
    ["PAGE_AUD", pages.aud],
    ["CONNECT_AUD", connect.aud],
    ["CONNECT_ACCESS_APP_ID", connect.id],
    ["MACHINE_DOMAIN", machineDomain],
    ["MACHINE_ZONE_ID", zoneId],
  ];
  const before = config;
  for (const [key, value] of wanted)
    if (vars.get(key) !== value) config = writeVar(config, key, value);
  if (routeHost !== host) config = writeRoute(config, host);
  if (config !== before) {
    NodeFS.writeFileSync(WRANGLER_CONFIG, config);
    console.log(
      "\nwrangler.jsonc changed. Commit it and merge it to main. The workflow deploys it.",
    );
  }

  const secrets = workerSecrets();
  if (secrets === null) {
    console.log(`\n${SECRETS_LATER}`);
    return 1;
  }
  if (!secrets.has("SECRET_KEY"))
    putSecret("SECRET_KEY", NodeCrypto.randomBytes(32).toString("base64"));
  if (!secrets.has("VAPID_JWK")) putSecret("VAPID_JWK", newVapidKey());
  if (!secrets.has("CF_API_TOKEN") || values["replace-token"]) putSecret("CF_API_TOKEN", token);
  const deployToken = NodeProcess.env.CLOUDFLARE_DEPLOY_TOKEN;
  if (deployToken) {
    const set = NodeChildProcess.spawnSync("gh", ["secret", "set", "CLOUDFLARE_DEPLOY_TOKEN"], {
      input: deployToken,
      encoding: "utf8",
    });
    if (set.status !== 0) throw new Error(`gh secret set failed: ${set.stderr}`);
    console.log("set      GitHub secret CLOUDFLARE_DEPLOY_TOKEN");
  }

  return (await check(api, host, zoneId)) && config === before ? 0 : 1;
}

NodeProcess.exit(await main());
