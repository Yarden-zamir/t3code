#!/usr/bin/env node
// MM-1215: the first-time setup of the portal. README "First-time setup" has the usage. Each run
// changes only what differs, and it never deploys: the workflow does that from main.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";

import {
  CloudflareApi,
  CloudflareApiError,
  isPermissionRefusal,
  ownerPolicy,
  type GuestApp,
} from "../src/cloudflare.ts";
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

// Access apps: found by the stored id or audience first, then by hostname, so the apps of a
// setup by hand count too. A stored value that matches no app stops the run: a new app would get
// a new audience and lock the owner out after the next deploy.

const normalHost = (uri: string): string => {
  let host = uri.trim().toLowerCase();
  while (host.endsWith("/")) host = host.slice(0, -1);
  return host;
};

const appHosts = (app: GuestApp) =>
  [...(app.destinations ?? []).flatMap((d) => (d.uri ? [d.uri] : [])), app.domain ?? ""]
    .filter((uri) => uri !== "")
    .map(normalHost);

class SetupStop extends Error {}

async function ensureApp(
  api: CloudflareApi,
  apps: ReadonlyArray<GuestApp>,
  label: string,
  uri: string,
  stored: { readonly id?: string | undefined; readonly aud?: string | undefined },
  body: Record<string, unknown>,
): Promise<{ readonly id: string; readonly aud: string }> {
  const byStored = apps.find(
    (app) =>
      (isSet(stored.id) && app.id === stored.id) || (isSet(stored.aud) && app.aud === stored.aud),
  );
  if (byStored === undefined && (isSet(stored.id) || isSet(stored.aud)))
    throw new SetupStop(
      `${label}: wrangler.jsonc names an app that this account does not have. Check ACCOUNT_ID, or set the value to REPLACE_ME to make a new app.`,
    );
  const found = byStored ?? apps.find((app) => appHosts(app).includes(normalHost(uri)));
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

/** Owner emails change only in wrangler.jsonc: an app that exists keeps its policy. */
function warnOwners(app: GuestApp | undefined, label: string, owners: ReadonlyArray<string>) {
  const wanted = JSON.stringify(
    ownerPolicy(owners)
      .include.map((r) => JSON.stringify(r))
      .toSorted(),
  );
  const matches = (app?.policies ?? []).some(
    (policy) =>
      policy.decision === "allow" &&
      JSON.stringify(policy.include.map((r) => JSON.stringify(r)).toSorted()) === wanted,
  );
  if (app !== undefined && !matches)
    console.log(
      `warning  ${label}: no policy of "${app.name}" lists exactly the owner emails. Check it in the Zero Trust dashboard.`,
    );
}

// Secrets go through the owner's `wrangler login`, never through the portal token.

function wrangler(
  accountId: string,
  args: ReadonlyArray<string>,
  input?: string,
): { ok: boolean; out: string } {
  const env: NodeJS.ProcessEnv = { ...NodeProcess.env, CLOUDFLARE_ACCOUNT_ID: accountId };
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

/** The secret names of the Worker, or null when the Worker does not exist yet. */
function workerSecrets(accountId: string): ReadonlySet<string> | null {
  const listed = wrangler(accountId, ["secret", "list", "--format", "json"]);
  if (!listed.ok) {
    // Cloudflare error 10007: the Worker does not exist. Any other failure is a real error.
    if (listed.out.includes("10007")) return null;
    throw new SetupStop(`wrangler secret list failed. Run wrangler login first.\n${listed.out}`);
  }
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

function putSecret(accountId: string, name: string, value: string): void {
  const put = wrangler(accountId, ["secret", "put", name], value);
  if (!put.ok) throw new Error(`wrangler secret put ${name} failed: ${put.out}`);
  console.log(`set      secret ${name}`);
}

/** `owner/name` of the `origin` remote on GitHub, so a fork never writes to its upstream. */
function originRepo(): string {
  const url = NodeChildProcess.execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
  }).trim();
  const mark = "github.com";
  const at = url.indexOf(mark);
  if (at === -1) throw new SetupStop(`origin is not on GitHub: ${url}. Pass --repo owner/name.`);
  const path = url.slice(at + mark.length + 1);
  return path.endsWith(".git") ? path.slice(0, -4) : path;
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
      "account-id": { type: "string" },
      repo: { type: "string" },
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

  const accounts = await new CloudflareApi(token, "").accounts();
  const storedAccount = values["account-id"] ?? vars.get("ACCOUNT_ID");
  const account =
    accounts.find((a) => a.id === storedAccount) ??
    (accounts.length === 1 ? accounts[0] : undefined);
  if (account === undefined) {
    console.error(
      `The token sees ${accounts.length} accounts, and ACCOUNT_ID is not one of them. Pass --account-id.`,
    );
    return 2;
  }
  const accountId = account.id;
  const api = new CloudflareApi(token, accountId);
  const zoneId = await api.zoneId(machineDomain);
  if (zoneId === null) {
    console.error(
      `No zone ${machineDomain}. Give the zone apex as --machine-domain, and give the token "DNS: Edit" on it.`,
    );
    return 2;
  }
  const teamDomain = await api.teamDomain();
  // A new Zero Trust organization has no login method, and the owner could not sign in.
  if ((await api.identityProviders()).length === 0) {
    await api.createOneTimePin();
    console.log("created  login method: One-time PIN");
  }

  // A stored value counts only for the account that the run uses.
  const sameAccount = vars.get("ACCOUNT_ID") === accountId;
  const stored = (key: string) => (sameAccount ? vars.get(key) : undefined);
  const apps = await api.accessApps();
  const pages = await ensureApp(
    api,
    apps,
    "portal pages",
    host,
    { aud: stored("PAGE_AUD") },
    {
      name: "t3 portal pages",
      session_duration: "720h",
      policies: [ownerPolicy(owners)],
    },
  );
  // The portal adds the policy of the machine tokens (MM-201). Until then, the app lets no one in.
  const connect = await ensureApp(
    api,
    apps,
    "machine connections",
    `${host}/connect`,
    { id: stored("CONNECT_ACCESS_APP_ID"), aud: stored("CONNECT_AUD") },
    { name: "t3 portal connect" },
  );
  await ensureApp(
    api,
    apps,
    "enrollment",
    `${host}/enroll`,
    {},
    {
      name: "t3 portal enroll",
      policies: [{ name: "t3 join codes", decision: "bypass", include: [{ everyone: {} }] }],
    },
  );
  const machines = await ensureApp(
    api,
    apps,
    "machine hostnames",
    `t3-*.${machineDomain}`,
    { id: stored("MACHINE_ACCESS_APP_ID") },
    { name: "t3 machine hosts", session_duration: "720h", policies: [ownerPolicy(owners)] },
  );
  warnOwners(
    apps.find((app) => app.id === pages.id),
    "portal pages",
    owners,
  );
  warnOwners(
    apps.find((app) => app.id === machines.id),
    "machine hostnames",
    owners,
  );

  const wanted: ReadonlyArray<readonly [string, string]> = [
    ["ACCOUNT_ID", accountId],
    ["TEAM_DOMAIN", teamDomain],
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

  // The first deploy needs this secret, so it comes before the Worker exists.
  const deployToken = NodeProcess.env.CLOUDFLARE_DEPLOY_TOKEN;
  if (deployToken) {
    const repo = values.repo ?? originRepo();
    const set = NodeChildProcess.spawnSync(
      "gh",
      ["secret", "set", "CLOUDFLARE_DEPLOY_TOKEN", "--repo", repo],
      { input: deployToken, encoding: "utf8" },
    );
    if (set.status !== 0) throw new Error(`gh secret set failed: ${set.stderr}`);
    console.log(`set      GitHub secret CLOUDFLARE_DEPLOY_TOKEN of ${repo}`);
  }

  const secrets = workerSecrets(accountId);
  if (secrets === null) {
    console.log(`\n${SECRETS_LATER}`);
    return 1;
  }
  if (!secrets.has("SECRET_KEY"))
    putSecret(accountId, "SECRET_KEY", NodeCrypto.randomBytes(32).toString("base64"));
  if (!secrets.has("VAPID_JWK")) putSecret(accountId, "VAPID_JWK", newVapidKey());
  if (!secrets.has("CF_API_TOKEN") || values["replace-token"])
    putSecret(accountId, "CF_API_TOKEN", token);

  return (await check(api, host, zoneId)) && config === before ? 0 : 1;
}

async function run(): Promise<number> {
  try {
    return await main();
  } catch (error) {
    // A Cloudflare refusal names the call; a stack trace adds nothing for the owner.
    if (!(error instanceof SetupStop) && !(error instanceof CloudflareApiError)) throw error;
    console.error(error.message);
    return 2;
  }
}

NodeProcess.exit(await run());
