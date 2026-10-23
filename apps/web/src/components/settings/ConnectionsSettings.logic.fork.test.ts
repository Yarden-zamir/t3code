import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { selectVisibleNetworkEndpoints } from "./ConnectionsSettings.logic";
import { resolveDesktopPairingUrl } from "./pairingUrls";

function makeEndpoint(overrides: Partial<AdvertisedEndpoint>): AdvertisedEndpoint {
  return {
    id: "desktop-lan:http://192.168.1.42:4780",
    label: "Local network",
    provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: "http://192.168.1.42:4780",
    wsBaseUrl: "ws://192.168.1.42:4780",
    reachability: "lan",
    compatibility: { hostedHttpsApp: "unknown", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  };
}

describe("selectVisibleNetworkEndpoints", () => {
  const loopback = makeEndpoint({ id: "desktop-loopback:3773", reachability: "loopback" });
  const tunnel = makeEndpoint({
    id: "tunnel:https://t3-mac.example.com",
    httpBaseUrl: "https://t3-mac.example.com",
  });

  it("keeps the tunnel endpoint on a loopback-only backend", () => {
    const visible = selectVisibleNetworkEndpoints({
      endpoints: [loopback, tunnel],
      isNetworkAccessible: false,
    });
    expect(visible).toEqual([tunnel]);
    // The copied link then opens the tunnel page, never t3code://app.
    expect(resolveDesktopPairingUrl(tunnel.httpBaseUrl, "TOKEN")).toBe(
      "https://t3-mac.example.com/pair#token=TOKEN",
    );
  });

  it("keeps every non-Tailscale-HTTPS endpoint on a network-accessible backend", () => {
    const magicDns = makeEndpoint({ id: "tailscale-magicdns:https://mac.ts.net" });
    expect(
      selectVisibleNetworkEndpoints({
        endpoints: [loopback, tunnel, magicDns],
        isNetworkAccessible: true,
      }),
    ).toEqual([loopback, tunnel]);
  });
});
