#!/usr/bin/env node
// MM-1215: the first-time setup of the portal, for what the portal cannot do before it runs: the
// Access app that locks the host to the owner emails, the values of wrangler.jsonc and the
// secrets. The Cloudflare view of the portal does the rest (MM-1218). README "First-time setup"
// has the usage. Each run changes only what differs, and it never deploys.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";

import { discoverAccessApp } from "../src/accessApps.ts";
import {
  allowsOnlyOwners,
  checkTokenPermissions,
  CloudflareApi,
  CloudflareApiError,
  ownerPolicy,
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

class SetupStop extends Error {}

/**
 * The Access app of the portal host, with the owner emails and a session of 30 days (MM-103). It
 * uses the one app that covers the host, as the portal does (MM-1216), so it also uses an app made
 * by hand. It never changes an app that exists.
 */
async function ensurePagesApp(
  api: CloudflareApi,
  host: string,
  owners: ReadonlyArray<string>,
): Promise<void> {
  const found = discoverAccessApp(await api.accessApps(), "pages", host, {
    machineDomain: null,
    added: [],
    reported: [],
  });
  if (found._tag === "many") throw new SetupStop(found.reason);
  if (found._tag === "found") {
    console.log(`ok       portal pages: the app "${found.app.name}" covers ${host}`);
    if (!allowsOnlyOwners(found.app, owners))
      console.log(
        `warning  portal pages: no policy of "${found.app.name}" lists exactly the owner emails. Check it in the Zero Trust dashboard.`,
      );
    return;
  }
  await api.createAccessApp({
    type: "self_hosted",
    name: "t3 portal pages",
    domain: host,
    destinations: [{ type: "public", uri: host }],
    app_launcher_visible: false,
    session_duration: "720h",
    policies: [ownerPolicy(owners)],
  });
  console.log(`created  portal pages: ${host}`);
}

// Secrets go through the owner's `wrangler login`, never through the portal token.

function wrangler(
  accountId: string,
  args: ReadonlyArray<string>,
  input?: string,
): { ok: boolean; stdout: string; out: string } {
  const env: NodeJS.ProcessEnv = { ...NodeProcess.env, CLOUDFLARE_ACCOUNT_ID: accountId };
  delete env.CF_API_TOKEN;
  delete env.CLOUDFLARE_API_TOKEN;
  const result = NodeChildProcess.spawnSync(WRANGLER, args, {
    cwd: NodePath.dirname(WRANGLER_CONFIG),
    env,
    input,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    // A missing binary leaves both outputs undefined.
    stdout: result.stdout ?? "",
    out: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`,
  };
}

/** The secret names of the Worker, or null when the Worker does not exist yet. */
function workerSecrets(accountId: string): ReadonlySet<string> | null {
  const listed = wrangler(accountId, ["secret", "list", "--format", "json"]);
  if (!listed.ok) {
    // Cloudflare error 10007: the Worker does not exist. Any other failure is a real error.
    if (listed.out.includes("10007")) return null;
    throw new SetupStop(`wrangler secret list failed. Run wrangler login first.\n${listed.out}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(listed.stdout);
  } catch {
    throw new SetupStop(`wrangler secret list gave no JSON list:\n${listed.out}`);
  }
  if (!Array.isArray(parsed)) throw new SetupStop("wrangler secret list gave no list.");
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
  if (!put.ok) throw new SetupStop(`wrangler secret put ${name} failed: ${put.out}`);
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

// The final check: what the token can read, and what a visitor without a login meets.

async function visit(host: string, path: string): Promise<"access" | "worker"> {
  const response = await fetch(`https://${host}${path}`, { redirect: "manual" });
  const location = response.headers.get("location") ?? "";
  return location.includes(".cloudflareaccess.com") ||
    location.includes("/cdn-cgi/access/") ||
    response.status === 403
    ? "access"
    : "worker";
}

async function check(api: CloudflareApi, host: string, zoneId: string): Promise<boolean> {
  console.log("\nCheck (read access only; a read does not prove edit access):");
  const permissions = await checkTokenPermissions(api, zoneId, host);
  for (const { permission, granted } of permissions)
    console.log(
      granted === true
        ? `ok       ${permission}`
        : granted === false
          ? `missing  ${permission}: add it to the portal token`
          : `unknown  ${permission}: Cloudflare gave another error`,
    );
  const results = permissions.map((p) => p.granted === true);
  // `/enroll` opens only after Repair in the Cloudflare view, so it is not checked here.
  for (const path of ["/", "/api/history", "/connect"]) {
    const seen = await visit(host, path).catch(() => "unreachable" as const);
    results.push(seen === "access");
    console.log(
      `${seen === "access" ? "ok      " : "wrong   "} GET ${path} without a login: ${seen}, want access`,
    );
  }
  return results.every(Boolean);
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
  const givenAccount = values["account-id"];
  const storedAccount = givenAccount ?? vars.get("ACCOUNT_ID");
  // An account given with --account-id must exist. Only a stored one falls back to the only account.
  const account =
    accounts.find((a) => a.id === storedAccount) ??
    (givenAccount === undefined && accounts.length === 1 ? accounts[0] : undefined);
  if (account === undefined) {
    console.error(
      `The token sees ${accounts.length} accounts, and ${givenAccount === undefined ? "ACCOUNT_ID" : "the --account-id value"} is not one of them. Pass --account-id with one of them.`,
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

  await ensurePagesApp(api, host, owners);

  const wanted: ReadonlyArray<readonly [string, string]> = [
    ["account_id", accountId],
    ["ACCOUNT_ID", accountId],
    ["TEAM_DOMAIN", teamDomain],
    ["OWNER_EMAILS", owners.join(",")],
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
    if (set.status !== 0)
      throw new SetupStop(`gh secret set failed: ${set.stderr ?? ""}${set.error?.message ?? ""}`);
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

  const checked = await check(api, host, zoneId);
  console.log(
    `\nOpen https://${host}/#/cloudflare and select Repair. It makes the other Access apps (MM-1219).`,
  );
  return checked && config === before ? 0 : 1;
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
