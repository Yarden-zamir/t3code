// A real Unix socket stands in for the kitshn link proxy.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { MachineId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { machineOfRequestNamespace, machineRequestNamespace } from "./machineAccess.ts";
import { KitshnAuditName, linkTargets, socketClient, withAuditName } from "./MachinePeers.ts";

/**
 * A copy of `linkTarget` in kitshn `packages/daemon/src/link.ts` (origin/main 9e6a638), the daemon side
 * of the link path contract. Copy it again when kitshn changes how it routes a link path.
 */
function kitshnLinkTarget(
  reachOf: (provider: string) => ReadonlyArray<{ machineId: string; address: string | null }>,
  url: URL,
  scheme: "https" | "http" = "https",
): { readonly target: URL } | { readonly error: string; readonly status: number } {
  const [, provider = "", machineId = "", ...rest] = url.pathname.split("/");
  const address = reachOf(provider).find(
    (card) => card.machineId === machineId && card.address !== null,
  )?.address;
  if (!address) return { error: `no address for ${provider}/${machineId}`, status: 403 };
  const target = new URL(`${scheme}://${address}/${rest.join("/")}${url.search}`);
  if (target.host !== address) return { error: `${url.pathname} leaves ${address}.`, status: 400 };
  return { target };
}

const card = (machineId: string, kind: string, level: string) => ({
  machineId,
  machineName: machineId.toUpperCase(),
  kind,
  id: kind === "t3.app" ? "app" : "th-1",
  address: kind === "t3.app" ? `t3-${machineId}.example.com` : null,
  level,
});

describe("linkTargets (K-1609)", () => {
  it("links each machine whose app card this machine reaches, with the access of its level", () => {
    const targets = linkTargets([
      card("vps", "t3.app", "use"),
      card("oracle", "t3.app", "view"),
      card("mac", "t3.app", "control"),
      card("pi", "t3.thread", "view"),
    ]);
    expect(targets).toEqual([
      { machine: { id: "vps", name: "VPS" }, origin: "http://link/t3/vps", access: "auto" },
      {
        machine: { id: "oracle", name: "ORACLE" },
        origin: "http://link/t3/oracle",
        access: "read-only",
      },
      { machine: { id: "mac", name: "MAC" }, origin: "http://link/t3/mac", access: "full-access" },
    ]);
  });

  it("builds an origin that the kitshn link proxy routes to the T3 card of that machine", () => {
    const reach = [card("vps", "t3.app", "use")];
    const [target] = linkTargets(reach);
    const routed = kitshnLinkTarget(
      (provider) => reach.filter(() => provider === "t3"),
      new URL(`${target?.origin}/.well-known/t3/environment?x=1`),
    );
    expect(routed).toEqual({
      target: new URL("https://t3-vps.example.com/.well-known/t3/environment?x=1"),
    });
  });
});

it.effect("names the tool of a forwarded call for the link proxy audit (K-1610)", () =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post("http://link/t3/vps/mcp");
    const named = yield* withAuditName(request).pipe(
      Effect.provideService(KitshnAuditName, "t3_thread_read"),
    );
    expect(named.headers["kitshn-audit-name"]).toBe("t3_thread_read");
    expect((yield* withAuditName(request)).headers["kitshn-audit-name"]).toBeUndefined();
  }),
);

it("names the source machine of a machine session namespace", () => {
  const namespace = machineRequestNamespace({
    machineId: MachineId.make("vps:1"),
    sessionId: "session",
  });
  expect(machineOfRequestNamespace(namespace)).toBe("vps:1");
  expect(machineOfRequestNamespace("provider:thread")).toBeUndefined();
});

describe("socketClient (K-1609)", () => {
  it.live("sends the request through the socket, not to the host name of the URL", () =>
    Effect.gen(function* () {
      const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-link-"));
      const socketPath = NodePath.join(folder, "link.sock");
      const server = NodeHttp.createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => response.end(JSON.stringify({ path: request.url, body })));
      });
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          server.listen(socketPath, () => resume(Effect.void));
        }),
        () =>
          Effect.sync(() => {
            server.close();
            NodeFS.rmSync(folder, { recursive: true, force: true });
          }),
      );
      // `link` is not a DNS name: only the socket can answer.
      const response = yield* socketClient(socketPath).execute(
        HttpClientRequest.get("http://link/t3/vps/.well-known/t3/environment"),
      );
      expect(yield* response.json).toEqual({
        path: "/t3/vps/.well-known/t3/environment",
        body: "",
      });
      // A pairing request sends a form body.
      const posted = yield* socketClient(socketPath).execute(
        HttpClientRequest.post("http://link/t3/vps/oauth/token").pipe(
          HttpClientRequest.bodyUrlParams({ grant_type: "x" }),
        ),
      );
      expect(yield* posted.json).toEqual({ path: "/t3/vps/oauth/token", body: "grant_type=x" });
    }).pipe(Effect.scoped),
  );
});
