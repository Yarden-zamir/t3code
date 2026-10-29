#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off - plain Node script.
// Fork: the portal lets go of the T3 host of one machine after kitshn took it over.
// See docs/fork/operations.md#hand-a-t3-host-over-to-kitshn.
//
//   CLOUDFLARE_HANDOVER_TOKEN_FILE=<path> node scripts/fork-host-handover.ts <machine> [--undo] [--dry-run]
//
// It takes the host out of the Access application "T3 Code servers" and deletes the ingress rule of
// the host on the portal tunnel `t3-<slug>`. It deletes no DNS record and never changes another
// Access application, so the path applications on `t3-vps` stay. `--undo` puts both back.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const API = "https://api.cloudflare.com/client/v4";
const PORTAL_APP_NAME = "T3 Code servers";
const DEFAULT_ZONE = "yarden-zamir.com";
const TUNNEL_SUFFIX = ".cfargotunnel.com";
/** Read-only fields of an Access app and of its policies. A PUT must not send them. */
const READ_ONLY_APP_FIELDS = ["id", "uid", "aud", "created_at", "updated_at"];
const READ_ONLY_POLICY_FIELDS = ["uid", "created_at", "updated_at", "reusable"];
const USAGE = "Usage: node scripts/fork-host-handover.ts <machine | host> [--undo] [--dry-run]";

type Json = Record<string, unknown>;

export interface HandoverOptions {
  readonly fetch: typeof fetch;
  readonly token: string;
  /** The folder of the saved ingress rules, one file per host. `--undo` reads them. */
  readonly stateDir: string;
  readonly log: (line: string) => void;
}

/** What `--undo` needs and the API no longer has after the handover. */
interface SavedRoute {
  readonly host: string;
  readonly tunnelId: string;
  readonly rule: Json;
}

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function jsonList(value: unknown, what: string): ReadonlyArray<Json> {
  if (!Array.isArray(value) || !value.every(isJson)) {
    throw new Error(`Cloudflare gave no list of ${what}.`);
  }
  return value;
}

function text(object: Json, key: string, what: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error(`${what} has no "${key}".`);
  return value;
}

/** Exactly one match, or a stop that names what it looked for. */
function one<T>(items: ReadonlyArray<T>, what: string): T {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error(`Found no ${what}.`);
  if (rest.length > 0) throw new Error(`Found ${items.length} ${what}, expected one.`);
  return first;
}

/** `mac` becomes `t3-mac.yarden-zamir.com`. A name with a dot is the full host already. */
export function hostOf(machine: string): string {
  const host = machine.includes(".")
    ? machine
    : `${machine.startsWith("t3-") ? machine : `t3-${machine}`}.${DEFAULT_ZONE}`;
  if (!host.startsWith("t3-")) throw new Error(`${host} is not a T3 host (t3-<slug>.<zone>).`);
  return host;
}

/** Every host and path that an Access application covers. */
function appHosts(app: Json): ReadonlyArray<string> {
  const destinations = Array.isArray(app.destinations) ? app.destinations.filter(isJson) : [];
  const fromDestinations = destinations.flatMap((d) =>
    d.type === "public" && typeof d.uri === "string" ? [d.uri] : [],
  );
  const domains = Array.isArray(app.self_hosted_domains) ? app.self_hosted_domains : [];
  return [
    ...fromDestinations,
    ...domains.filter((d): d is string => typeof d === "string"),
    ...(typeof app.domain === "string" ? [app.domain] : []),
  ];
}

function ingressOf(configuration: Json): ReadonlyArray<Json> {
  const config = isJson(configuration.config) ? configuration.config : {};
  return config.ingress === undefined ? [] : jsonList(config.ingress, "ingress rules");
}

/** cloudflared needs a last rule without a hostname. A missing one is a broken tunnel, so it stops. */
function checkCatchAllLast(rules: ReadonlyArray<Json>, tunnelName: string): void {
  const last = rules.at(-1);
  if (last === undefined || last.hostname !== undefined) {
    throw new Error(`The tunnel ${tunnelName} has no catch-all rule last. Fix it by hand first.`);
  }
}

export interface HandoverArgs {
  readonly host: string;
  readonly undo: boolean;
  readonly dryRun: boolean;
}

export function parseArgs(args: ReadonlyArray<string>): HandoverArgs {
  const rest = args.filter((arg) => arg !== "--undo" && arg !== "--dry-run");
  const [machine] = rest;
  if (machine === undefined || rest.length !== 1 || machine.startsWith("-")) {
    throw new Error(USAGE);
  }
  return {
    host: hostOf(machine),
    undo: args.includes("--undo"),
    dryRun: args.includes("--dry-run"),
  };
}

export async function runHandover(
  { host, undo, dryRun }: HandoverArgs,
  options: HandoverOptions,
): Promise<void> {
  const dot = host.indexOf(".");
  const label = host.slice(0, dot);
  const zoneName = host.slice(dot + 1);
  const { log } = options;
  const statePath = NodePath.join(options.stateDir, `${host}.json`);

  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await options.fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const envelope: unknown = await response.json().catch(() => null);
    if (!response.ok || !isJson(envelope) || envelope.success !== true) {
      const errors = isJson(envelope) && Array.isArray(envelope.errors) ? envelope.errors : [];
      const detail = errors
        .filter(isJson)
        .map((e) => `${String(e.code)} ${String(e.message)}`)
        .join("; ");
      throw new Error(`Cloudflare API ${method} ${path} failed: ${detail || response.status}`);
    }
    return envelope.result;
  };
  const get = (path: string) => call("GET", path);
  /** In a dry run, it prints the change and sends nothing. */
  const change = async (method: "PUT", path: string, body: unknown): Promise<unknown> => {
    log(`   ${dryRun ? "would send" : "sends"} ${method} ${path}`);
    return dryRun ? null : call(method, path, body);
  };

  log(`${dryRun ? "Dry run: " : ""}${undo ? "Undo the handover of" : "Hand over"} ${host}.`);

  log(`1. Find the zone ${zoneName} and its account.`);
  const zone = one(
    jsonList(await get(`/zones?name=${encodeURIComponent(zoneName)}`), "zones").filter(
      (z) => z.name === zoneName,
    ),
    `zone ${zoneName}`,
  );
  const zoneId = text(zone, "id", "The zone");
  const accountId = text(isJson(zone.account) ? zone.account : {}, "id", "The zone account");
  const account = `/accounts/${accountId}`;

  log(`2. Find the Access application "${PORTAL_APP_NAME}" and the portal tunnel ${label}.`);
  const apps = jsonList(await get(`${account}/access/apps?per_page=1000`), "Access applications");
  const portalApp = one(
    apps.filter((app) => app.name === PORTAL_APP_NAME),
    `Access application named "${PORTAL_APP_NAME}"`,
  );
  const appPath = `${account}/access/apps/${text(portalApp, "id", "The portal application")}`;
  const tunnel = one(
    jsonList(
      await get(`${account}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(label)}`),
      "tunnels",
    ).filter((t) => t.name === label),
    `tunnel named ${label}`,
  );
  const tunnelId = text(tunnel, "id", "The portal tunnel");
  const configPath = `${account}/cfd_tunnel/${tunnelId}/configurations`;

  const configuration = await get(configPath);
  if (!isJson(configuration)) throw new Error(`The tunnel ${label} gave no configuration.`);
  const config = isJson(configuration.config) ? configuration.config : {};
  const rules = ingressOf(configuration);
  const portalRule = rules.find((rule) => rule.hostname === host);

  if (!undo) {
    log("3. Check that kitshn took the address.");
    const notTaken = (why: string) =>
      new Error(
        `${why} Run "Take the address…" on the T3 card in kitshn first, then run this again.`,
      );
    const records = jsonList(
      await get(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(host)}`),
      "DNS records",
    ).filter((record) => record.name === host);
    const [record] = records;
    if (record === undefined || records.length > 1) {
      throw notTaken(`${host} has ${records.length} DNS records, expected one CNAME record.`);
    }
    const content = typeof record.content === "string" ? record.content : "";
    if (record.type !== "CNAME" || !content.endsWith(TUNNEL_SUFFIX)) {
      throw notTaken(`The DNS record of ${host} does not point at a tunnel.`);
    }
    if (content === `${tunnelId}${TUNNEL_SUFFIX}`) {
      throw notTaken(`The DNS record of ${host} still points at the portal tunnel ${label}.`);
    }
    const kitshnApps = apps.filter(
      (app) => app.name !== PORTAL_APP_NAME && appHosts(app).includes(`${host}/*`),
    );
    if (kitshnApps.length === 0) {
      throw notTaken(`No Access application covers ${host}/* next to "${PORTAL_APP_NAME}".`);
    }
    log(
      `   ok: the record points at ${content}, and "${String(kitshnApps[0]?.name)}" covers ${host}/*.`,
    );

    log(`4. Save the portal ingress rule of ${host} for --undo.`);
    if (portalRule === undefined) {
      log("   nothing to save: the tunnel has no rule for the host.");
    } else if (dryRun) {
      log(`   would write ${statePath}`);
    } else {
      const saved: SavedRoute = { host, tunnelId, rule: portalRule };
      NodeFS.mkdirSync(options.stateDir, { recursive: true });
      NodeFS.writeFileSync(statePath, `${JSON.stringify(saved, null, 2)}\n`);
      log(`   wrote ${statePath}`);
    }

    log(`5. Take ${host} out of "${PORTAL_APP_NAME}".`);
    await editAppHosts(appPath, (hosts) =>
      hosts.includes(host) ? hosts.filter((h) => h !== host) : null,
    );

    log(`6. Delete the ingress rule of ${host} on the portal tunnel ${label}.`);
    if (portalRule === undefined) {
      log("   already done.");
    } else {
      const next = rules.filter((rule) => rule.hostname !== host);
      checkCatchAllLast(next, label);
      await change("PUT", configPath, { config: { ...config, ingress: next } });
      log(`   ${dryRun ? "would delete" : "deleted"} ${host} -> ${String(portalRule.service)}.`);
    }

    log(`Done. The portal deleted no DNS record and changed no other Access application.`);
    return;
  }

  log(`3. Read the saved ingress rule from ${statePath}.`);
  if (!NodeFS.existsSync(statePath)) {
    throw new Error(`${statePath} does not exist. Undo needs the rule that the handover saved.`);
  }
  const saved: unknown = JSON.parse(NodeFS.readFileSync(statePath, "utf8"));
  if (!isJson(saved) || saved.host !== host || !isJson(saved.rule)) {
    throw new Error(`${statePath} is not a saved rule of ${host}.`);
  }
  if (saved.tunnelId !== tunnelId) {
    throw new Error(`${statePath} names the tunnel ${String(saved.tunnelId)}, not ${tunnelId}.`);
  }
  const savedRule = saved.rule;

  log(`4. Put the ingress rule of ${host} back on the portal tunnel ${label}.`);
  if (portalRule !== undefined) {
    log("   already done.");
  } else {
    const next =
      rules.length === 0 ? [savedRule, { service: "http_status:404" }] : [savedRule, ...rules];
    checkCatchAllLast(next, label);
    await change("PUT", configPath, { config: { ...config, ingress: next } });
    log(`   ${dryRun ? "would add" : "added"} ${host} -> ${String(savedRule.service)}.`);
  }

  log(`5. Put ${host} back into "${PORTAL_APP_NAME}".`);
  await editAppHosts(appPath, (hosts) => (hosts.includes(host) ? null : [...hosts, host]));

  log(
    `Done. kitshn's Access application, ingress rule and DNS record stay. The record still points at kitshn. To point it back at the portal, use "Give the address back…" on the T3 card in kitshn.`,
  );

  /**
   * PUT replaces the whole app, so it sends back every field that GET gave, with the policies.
   * Same shape as `CloudflareApi.#editAppHostnames` in apps/machine-map/src/cloudflare.ts.
   */
  async function editAppHosts(
    path: string,
    edit: (hosts: ReadonlyArray<string>) => ReadonlyArray<string> | null,
  ): Promise<void> {
    const raw = await get(path);
    if (!isJson(raw)) throw new Error(`"${PORTAL_APP_NAME}" gave no application.`);
    const destinations = Array.isArray(raw.destinations) ? raw.destinations.filter(isJson) : [];
    const hosts = destinations.flatMap((d) =>
      d.type === "public" && typeof d.uri === "string" ? [d.uri] : [],
    );
    const next = edit(hosts);
    if (next === null) {
      log("   already done.");
      return;
    }
    const [first] = next;
    if (first === undefined) throw new Error(`"${PORTAL_APP_NAME}" needs at least one host.`);
    const body: Json = { ...raw };
    for (const field of READ_ONLY_APP_FIELDS) delete body[field];
    // `self_hosted_domains` is the deprecated twin of the public destinations.
    delete body.self_hosted_domains;
    body.domain = first;
    body.destinations = [
      ...destinations.filter((d) => d.type !== "public"),
      ...next.map((uri) => ({ type: "public", uri })),
    ];
    const policies = Array.isArray(raw.policies) ? raw.policies.filter(isJson) : [];
    if (Array.isArray(raw.policies)) {
      body.policies = policies.map((policy) => {
        const copy = { ...policy };
        for (const field of READ_ONLY_POLICY_FIELDS) delete copy[field];
        return copy;
      });
    }
    const updated = await change("PUT", path, body);
    if (dryRun) {
      log(`   would set the hosts to: ${next.join(", ")}`);
      return;
    }
    // A lost policy locks the owner out, so it says so loudly.
    const kept = new Set(
      (isJson(updated) && Array.isArray(updated.policies) ? updated.policies : [])
        .filter(isJson)
        .map((policy) => policy.id),
    );
    const lost = policies.filter((policy) => !kept.has(policy.id));
    if (lost.length > 0) {
      throw new Error(
        `"${PORTAL_APP_NAME}" lost ${lost.length} policies in the update. Check it in the Zero Trust dashboard now.`,
      );
    }
    log(`   done. Hosts now: ${next.join(", ")}`);
  }
}

function readToken(env: NodeJS.ProcessEnv): string {
  const file = env.CLOUDFLARE_HANDOVER_TOKEN_FILE;
  const token = (
    file ? NodeFS.readFileSync(file, "utf8") : (env.CLOUDFLARE_HANDOVER_TOKEN ?? "")
  ).trim();
  if (token === "") {
    throw new Error(
      "Set CLOUDFLARE_HANDOVER_TOKEN, or CLOUDFLARE_HANDOVER_TOKEN_FILE to a file with the token. It needs Access: Apps and Policies Edit, Cloudflare Tunnel Edit and DNS Read.",
    );
  }
  return token;
}

if (import.meta.main) {
  try {
    const env = NodeProcess.env;
    await runHandover(parseArgs(NodeProcess.argv.slice(2)), {
      fetch,
      token: readToken(env),
      stateDir:
        env.T3_HOST_HANDOVER_STATE_DIR ??
        NodePath.join(NodeOS.homedir(), ".local", "state", "t3-host-handover"),
      log: (line) => console.log(line),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
