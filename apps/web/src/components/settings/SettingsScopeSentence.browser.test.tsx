import type { MachineMapCircleSettings } from "@t3tools/contracts";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import type { SettingsScopeSearch } from "./settingsScope";

const mocks = vi.hoisted(() => ({
  circles: [] as MachineMapCircleSettings[],
  search: {} as SettingsScopeSearch,
  selectScope: vi.fn<(next: SettingsScopeSearch) => void>(),
  send: vi.fn<(request: unknown) => Promise<unknown>>(),
}));

vi.mock(import("../../state/machineMap"), async (original) => ({
  ...(await original()),
  useMachineMapState: (() => ({
    state: { joined: true, owner: true, circles: mocks.circles },
    error: null,
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => mocks.send) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useOptionalSettingsScope: (() => ({
    search: mocks.search,
    selectScope: mocks.selectScope,
    singleEnvironment: false,
    groups: [],
    scope: { kind: "all", label: "All environments", members: [], environmentIds: [] },
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
  usePrimaryEnvironmentId: (() => "mac") as never,
}));

import { SettingsScopeSentence } from "./SettingsScopeSentence";

const PARTNER: MachineMapCircleSettings = {
  id: "partner",
  name: "Partner",
  color: "#FF5277",
  settings: { server: { sidebarTabs: {} }, client: {} },
};

// The sentence reads the matched route, which the shared test router (one root route) lacks.
function renderAt(path: string) {
  const root = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path, component: SettingsScopeSentence }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(<RouterProvider router={router} />, { router: false });
}

function setup(input: { circles: MachineMapCircleSettings[]; search: SettingsScopeSearch }) {
  mocks.circles = input.circles;
  mocks.search = input.search;
  mocks.selectScope.mockClear();
  mocks.send.mockReset();
  mocks.send.mockResolvedValue(AsyncResult.success({}));
}

it("shows the person picker to the owner on a page with person settings", async () => {
  setup({ circles: [PARTNER], search: {} });
  await using _screen = await renderAt("/settings/general");
  await expect.element(page.getByText("Applying settings for")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Person scope: All people" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: /Partner/ }));
  expect(mocks.selectScope).toHaveBeenCalledWith({ circle: "partner" });
  await expect.element(page.getByRole("button", { name: /^Reset/ })).not.toBeInTheDocument();
});

it("names the picked circle and resets its part", async () => {
  setup({ circles: [PARTNER], search: { circle: "partner" } });
  await using _screen = await renderAt("/settings/general");
  await userEvent.click(page.getByRole("button", { name: "Reset Partner" }));
  expect(mocks.send).toHaveBeenCalledWith({
    environmentId: "mac",
    input: { circleId: "partner", server: {}, client: {}, reset: true },
  });
  await userEvent.click(page.getByRole("button", { name: "Person scope: Partner" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "All people" }));
  expect(mocks.selectScope).toHaveBeenCalledWith({});
});

it("shows no sentence on a device page without circles to pick", async () => {
  setup({ circles: [], search: {} });
  await using _screen = await renderAt("/settings/general");
  await expect.element(page.getByText("Applying settings for")).not.toBeInTheDocument();
});
