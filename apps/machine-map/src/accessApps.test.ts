import { expect, it } from "vite-plus/test";

import { discoverAccessApp } from "./accessApps.ts";
import type { GuestApp } from "./cloudflare.ts";

const app = (id: string, ...uris: Array<string>): GuestApp => ({
  id,
  name: id,
  type: "self_hosted",
  destinations: uris.map((uri) => ({ type: "public", uri })),
});
const hosts = { machineDomain: "example.com", added: [], reported: [] };

it("finds the machine hostnames app by its wildcard, then by the tunnel hostnames", () => {
  const apps = [
    app("hand", "t3-mac.example.com", "t3-vps.example.com"),
    app("guest", "t3-mac.example.com/guest"),
  ];
  expect(discoverAccessApp(apps, "machines", "t3.example.com", hosts)).toMatchObject({
    _tag: "none",
  });
  expect(
    discoverAccessApp(apps, "machines", "t3.example.com", {
      ...hosts,
      reported: ["t3-vps.example.com"],
    }),
  ).toMatchObject({ _tag: "found", app: { id: "hand" } });
  const withWildcard = [...apps, app("wild", "t3-*.example.com")];
  expect(
    discoverAccessApp(withWildcard, "machines", "t3.example.com", {
      ...hosts,
      added: ["t3-mac.example.com"],
    }),
  ).toMatchObject({ _tag: "found", app: { id: "wild" } });
});

it("never picks one of two apps on the same path, and skips apps that are not self-hosted", () => {
  const twins = [app("a", "t3.example.com/connect"), app("b", "t3.example.com/connect/")];
  expect(discoverAccessApp(twins, "connect", "t3.example.com", hosts)._tag).toBe("many");
  const bookmark = { ...app("bookmark", "t3.example.com"), type: "bookmark" };
  expect(discoverAccessApp([bookmark], "pages", "t3.example.com", hosts)._tag).toBe("none");
});
