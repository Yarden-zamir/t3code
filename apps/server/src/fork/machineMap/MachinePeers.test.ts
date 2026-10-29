import { MachineId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { machineOfRequestNamespace, machineRequestNamespace } from "./machineAccess.ts";
import { linkTargets } from "./MachinePeers.ts";

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
  id: kind === "t3.app" ? "app" : "agents",
  address: kind === "t3.app" ? `t3-${machineId}.example.com` : null,
  level,
});

describe("linkTargets (K-1609)", () => {
  it("links a machine only with both cards, with the access of its app card", () => {
    const targets = linkTargets([
      card("vps", "t3.app", "use"),
      card("vps", "t3.agents", "exec"),
      card("oracle", "t3.app", "view"),
      card("oracle", "t3.agents", "exec"),
      card("mac", "t3.app", "control"),
      card("pi", "t3.agents", "use"),
    ]);
    expect(targets).toEqual([
      {
        machine: { id: "vps", name: "VPS" },
        origin: "http://link/t3/vps",
        access: "auto",
        exec: true,
      },
      // Exec also needs t3.app at use or control.
      {
        machine: { id: "oracle", name: "ORACLE" },
        origin: "http://link/t3/oracle",
        access: "read-only",
        exec: false,
      },
    ]);
  });

  it("builds an origin that the kitshn link proxy routes to the T3 card of that machine", () => {
    const reach = [card("vps", "t3.app", "use"), card("vps", "t3.agents", "exec")];
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

it("names the source machine of a machine session namespace", () => {
  const namespace = machineRequestNamespace({
    machineId: MachineId.make("vps:1"),
    sessionId: "session",
  });
  expect(machineOfRequestNamespace(namespace)).toBe("vps:1");
  expect(machineOfRequestNamespace("provider:thread")).toBeUndefined();
});
