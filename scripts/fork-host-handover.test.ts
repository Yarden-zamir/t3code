// @effect-diagnostics nodeBuiltinImport:off - plain Node tests with a fake Cloudflare API.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";

import { parseArgs, runHandover } from "./fork-host-handover.ts";

const HOST = "t3-vps.yarden-zamir.com";
const PORTAL_TUNNEL = "portal-tunnel";
const KITSHN_TUNNEL = "kitshn-tunnel";

type Json = Record<string, unknown>;

/** The live shape on 2026-10-29: kitshn took the address, and the portal still holds the host. */
function makeCloudflare() {
  const apps: Record<string, Json> = {
    servers: {
      id: "servers",
      aud: "aud-servers",
      name: "T3 Code servers",
      domain: "t3-mac.yarden-zamir.com",
      destinations: [
        { type: "public", uri: "t3-mac.yarden-zamir.com" },
        { type: "public", uri: HOST },
      ],
      self_hosted_domains: ["t3-mac.yarden-zamir.com", HOST],
      policies: [{ id: "owner", name: "owner", decision: "allow", uid: "u" }],
    },
    kitshn: {
      id: "kitshn",
      name: "kitshn t3",
      destinations: [{ type: "public", uri: `${HOST}/*` }],
    },
    assets: {
      id: "assets",
      name: "T3 web build",
      destinations: [{ type: "public", uri: `${HOST}/assets/*` }],
    },
    guest: { id: "guest", name: "T3 guest links", domain: `${HOST}/guest` },
  };
  const tunnels: Array<Json> = [
    { id: PORTAL_TUNNEL, name: "t3-vps", config_src: "cloudflare" },
    { id: KITSHN_TUNNEL, name: "kitshn vps-1", config_src: "cloudflare" },
    { id: "mac-tunnel", name: "t3-mac", config_src: "cloudflare" },
  ];
  const configs: Record<string, Json> = {
    [PORTAL_TUNNEL]: {
      ingress: [
        { hostname: HOST, service: "http://127.0.0.1:3773" },
        { hostname: "other.yarden-zamir.com", service: "http://127.0.0.1:9000" },
        { service: "http_status:404" },
      ],
      "warp-routing": { enabled: false },
    },
  };
  const records: Array<Json> = [
    { id: "rec", name: HOST, type: "CNAME", content: `${KITSHN_TUNNEL}.cfargotunnel.com` },
  ];
  const calls: Array<{ method: string; path: string }> = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    calls.push({ method, path: `${path}${url.search}` });
    const body: Json = init?.body ? JSON.parse(String(init.body)) : {};
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    const parts = path.split("/");
    if (method === "GET" && path === "/zones") {
      return ok([{ id: "zone", name: url.searchParams.get("name"), account: { id: "acc" } }]);
    }
    if (method === "GET" && path === "/zones/zone/dns_records") {
      return ok(records.filter((r) => r.name === url.searchParams.get("name")));
    }
    if (method === "GET" && path === "/accounts/acc/access/apps") return ok(Object.values(apps));
    if (path.startsWith("/accounts/acc/access/apps/")) {
      const id = parts[5] ?? "";
      if (method === "GET") return ok(apps[id]);
      if (method === "PUT") {
        apps[id] = { ...body, id };
        return ok(apps[id]);
      }
    }
    if (method === "GET" && path === "/accounts/acc/cfd_tunnel") {
      const name = url.searchParams.get("name");
      const uuid = url.searchParams.get("uuid");
      return ok(
        tunnels.filter(
          (t) => (name === null || t.name === name) && (uuid === null || t.id === uuid),
        ),
      );
    }
    if (path.endsWith("/configurations")) {
      const id = parts[4] ?? "";
      if (method === "GET") return ok({ tunnel_id: id, config: configs[id] ?? null });
      if (method === "PUT") {
        configs[id] = isJson(body.config) ? body.config : {};
        return ok({});
      }
    }
    return Response.json(
      { success: false, errors: [{ code: 7000, message: "No route" }] },
      { status: 404 },
    );
  };
  return { apps, tunnels, configs, records, calls, fetch };
}

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function makeStateDir(): { readonly path: string } & Disposable {
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-host-handover-"));
  return { path, [Symbol.dispose]: () => NodeFS.rmSync(path, { recursive: true, force: true }) };
}

async function run(
  cloudflare: ReturnType<typeof makeCloudflare>,
  stateDir: string,
  args: Array<string>,
) {
  const lines: Array<string> = [];
  await runHandover(parseArgs(args), {
    fetch: cloudflare.fetch,
    token: "secret-token",
    stateDir,
    log: (line) => lines.push(line),
  });
  return lines;
}

const writes = (cloudflare: ReturnType<typeof makeCloudflare>) =>
  cloudflare.calls.filter((call) => call.method !== "GET");

function portalHosts(cloudflare: ReturnType<typeof makeCloudflare>) {
  const destinations = cloudflare.apps.servers?.destinations;
  return Array.isArray(destinations) ? destinations.filter(isJson).map((d) => d.uri) : [];
}

it("takes only the host out of the portal app and tunnel, and is idempotent", async () => {
  using state = makeStateDir();
  const cloudflare = makeCloudflare();
  const pathApps = structuredClone([
    cloudflare.apps.kitshn,
    cloudflare.apps.assets,
    cloudflare.apps.guest,
  ]);

  const lines = await run(cloudflare, state.path, ["vps"]);

  expect(portalHosts(cloudflare)).toEqual(["t3-mac.yarden-zamir.com"]);
  expect(cloudflare.apps.servers?.policies).toEqual([
    { id: "owner", name: "owner", decision: "allow" },
  ]);
  expect([cloudflare.apps.kitshn, cloudflare.apps.assets, cloudflare.apps.guest]).toEqual(pathApps);
  expect(cloudflare.configs[PORTAL_TUNNEL]).toEqual({
    ingress: [
      { hostname: "other.yarden-zamir.com", service: "http://127.0.0.1:9000" },
      { service: "http_status:404" },
    ],
    "warp-routing": { enabled: false },
  });
  expect(writes(cloudflare).map((call) => call.path)).toEqual([
    "/accounts/acc/access/apps/servers",
    `/accounts/acc/cfd_tunnel/${PORTAL_TUNNEL}/configurations`,
  ]);
  expect(lines.join("\n")).not.toContain("secret-token");

  cloudflare.calls.length = 0;
  const again = await run(cloudflare, state.path, ["vps"]);
  expect(writes(cloudflare)).toEqual([]);
  expect(again.filter((line) => line.includes("already done"))).toHaveLength(2);
});

it("changes nothing in a dry run", async () => {
  using state = makeStateDir();
  const cloudflare = makeCloudflare();
  await run(cloudflare, state.path, ["vps", "--dry-run"]);
  expect(writes(cloudflare)).toEqual([]);
  expect(NodeFS.readdirSync(state.path)).toEqual([]);
});

it.each([
  [
    "the record still points at the portal tunnel",
    (cf: ReturnType<typeof makeCloudflare>) => {
      cf.records[0] = { ...cf.records[0], content: `${PORTAL_TUNNEL}.cfargotunnel.com` };
    },
    "Take the address",
  ],
  [
    "no application covers <host>/*",
    (cf: ReturnType<typeof makeCloudflare>) => {
      delete cf.apps.kitshn;
    },
    "Take the address",
  ],
  [
    "two applications are named T3 Code servers",
    (cf: ReturnType<typeof makeCloudflare>) => {
      cf.apps.copy = { ...cf.apps.servers, id: "copy" };
    },
    "expected one",
  ],
  [
    "the record points at another portal tunnel",
    (cf: ReturnType<typeof makeCloudflare>) => {
      cf.records[0] = { ...cf.records[0], content: "mac-tunnel.cfargotunnel.com" };
    },
    "Take the address",
  ],
  [
    "the <host>/* application is not kitshn's",
    (cf: ReturnType<typeof makeCloudflare>) => {
      cf.apps.kitshn = { ...cf.apps.kitshn, name: "someone else" };
    },
    "Take the address",
  ],
  [
    "the portal tunnel is managed on its machine",
    (cf: ReturnType<typeof makeCloudflare>) => {
      cf.tunnels[0] = { ...cf.tunnels[0], config_src: "local" };
    },
    "managed on its machine",
  ],
  [
    "the portal application lost its policies, also with the host gone already",
    (cf: ReturnType<typeof makeCloudflare>) => {
      cf.apps.servers = {
        ...cf.apps.servers,
        destinations: [{ type: "public", uri: "t3-mac.yarden-zamir.com" }],
        policies: [],
      };
    },
    "no policies",
  ],
] as const)("refuses and changes nothing when %s", async (_name, arrange, message) => {
  using state = makeStateDir();
  const cloudflare = makeCloudflare();
  arrange(cloudflare);
  await expect(run(cloudflare, state.path, ["vps"])).rejects.toThrow(message);
  expect(writes(cloudflare)).toEqual([]);
});

it("--undo puts the host and the old ingress rule back and deletes nothing", async () => {
  using state = makeStateDir();
  const cloudflare = makeCloudflare();
  await run(cloudflare, state.path, ["vps"]);

  await run(cloudflare, state.path, ["vps", "--undo"]);

  expect(portalHosts(cloudflare)).toEqual(["t3-mac.yarden-zamir.com", HOST]);
  const ingress = cloudflare.configs[PORTAL_TUNNEL]?.ingress as Array<Json>;
  expect(ingress).toContainEqual({ hostname: HOST, service: "http://127.0.0.1:3773" });
  expect(ingress.at(-1)).toEqual({ service: "http_status:404" });
  expect(cloudflare.apps.kitshn).toBeDefined();
  expect(cloudflare.records).toHaveLength(1);
  expect(cloudflare.calls.filter((call) => call.method === "DELETE")).toEqual([]);
});
