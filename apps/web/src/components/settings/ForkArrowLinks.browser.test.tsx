import { ARROW_LINK_NO_EXPIRY, EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ links: [] as ReadonlyArray<unknown> }));

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: { links: state.links }, error: null })) as never,
}));
// The session may link and unlink: the fork still offers neither (MM-1921).
vi.mock(import("~/state/peerLinks"), async (original) => ({
  ...(await original()),
  peerLinkEnvironment: {
    list: () => null,
    link: { permissionAtom: () => Atom.make(true) },
    unlink: { permissionAtom: () => Atom.make(true) },
  } as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      {
        environmentId: EnvironmentId.make("mac"),
        serverConfig: { settings: { machineMap: { portalUrl: "https://portal.example.com" } } },
      },
    ],
  })) as never,
}));

import { LinkedEnvironmentsSettings } from "./LinkedEnvironmentsSettings";

const link = (label: string, expiresAt: string): PeerLinkSummary => ({
  environmentId: EnvironmentId.make(`environment-${label}`),
  label,
  urls: [`https://${label}.example.com`],
  access: "auto",
  linkedAt: DateTime.makeUnsafe("2026-10-20T08:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe(expiresAt),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
});

const setup = (links: ReadonlyArray<PeerLinkSummary>) => {
  state.links = links;
};

it("shows kitshn links read-only, with the real end of a share", async () => {
  setup([link("vps", ARROW_LINK_NO_EXPIRY), link("win", "2099-01-02T03:04:00.000Z")]);
  await using screen = await render(
    <LinkedEnvironmentsSettings
      environmentId={EnvironmentId.make("mac")}
      environmentLabel={null}
      isSearchTarget={false}
    />,
  );
  // A page outside a kitshn zone (here localhost) has no map to open.
  expect(screen.getByRole("link", { name: "Change access on the map" }).query()).toBeNull();
  expect(screen.getByRole("button", { name: "Link" }).query()).toBeNull();
  expect(screen.getByRole("button", { name: "Forget" }).query()).toBeNull();
  await expect
    .element(screen.getByText(/Reachable until .*2099.*Renew it on the kitshn map/))
    .toBeVisible();
  expect(screen.getByText(/Link it again/).query()).toBeNull();
  expect(screen.getByText(/9999/).query()).toBeNull();
});

it("points an empty list to the kitshn map instead of manual linking", async () => {
  setup([]);
  await using screen = await render(
    <LinkedEnvironmentsSettings
      environmentId={EnvironmentId.make("mac")}
      environmentLabel={null}
      isSearchTarget={false}
    />,
  );
  await expect.element(screen.getByText(/on the kitshn map\.$/)).toBeVisible();
  expect(screen.getByText(/Link another machine/).query()).toBeNull();
  expect(screen.getByRole("button", { name: "Link" }).query()).toBeNull();
});
