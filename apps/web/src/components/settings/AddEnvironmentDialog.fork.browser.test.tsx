import { render, stubGlobal } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import {
  connectPairing,
  readRequestHeaders,
  saveRequestHeaders,
} from "../../connection/onboarding";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ readonly command: string; readonly input: unknown }>,
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => async (input: unknown) => {
    const name =
      command === connectPairing
        ? "connectPairing"
        : command === readRequestHeaders
          ? "readRequestHeaders"
          : command === saveRequestHeaders
            ? "saveRequestHeaders"
            : "other";
    state.calls.push({ command: name, input });
    if (name === "readRequestHeaders") {
      return { _tag: "Success", value: [{ name: "X-Previous", value: "kept" }] };
    }
    if (name === "connectPairing") {
      return { _tag: "Failure", cause: Cause.fail(new Error("Pairing code expired.")) };
    }
    return { _tag: "Success", value: undefined };
  }) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useRelayEnvironmentDiscovery: (() => ({ environments: new Map() })) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: vi.fn() } };
});

import { AddEnvironmentDialog } from "./AddEnvironmentDialog";

it("saves request headers before pairing and restores them when pairing fails", async () => {
  state.calls = [];
  const onErrorChange = vi.fn();
  // Request headers need the desktop connection catalog.
  using _bridge = stubGlobal("desktopBridge", { setConnectionCatalog: vi.fn() });
  await using _screen = await render(
    <RegistryProvider>
      <AddEnvironmentDialog
        open
        routeTarget={null}
        error={null}
        savedEnvironments={[]}
        onOpenChange={vi.fn()}
        onErrorChange={onErrorChange}
      />
    </RegistryProvider>,
  );

  await userEvent.fill(page.getByPlaceholder("backend.example.com"), "backend.example.com");
  await userEvent.fill(page.getByPlaceholder("PAIRCODE"), "PAIRCODE");
  await userEvent.click(page.getByRole("button", { name: "Request headers" }));
  await userEvent.fill(page.getByLabelText("Cloudflare Access Client ID"), "client-id");
  await userEvent.fill(page.getByLabelText("Cloudflare Access Client Secret"), "client-secret");
  await userEvent.click(page.getByRole("button", { name: "Add environment" }).last());

  await vi.waitFor(() => expect(onErrorChange).toHaveBeenLastCalledWith("Pairing code expired."));
  const commands = state.calls.map((call) => call.command);
  expect(commands).toEqual([
    "readRequestHeaders",
    "saveRequestHeaders",
    "connectPairing",
    "saveRequestHeaders",
  ]);
  const [saved, restored] = state.calls.filter((call) => call.command === "saveRequestHeaders");
  expect(saved?.input).toMatchObject({
    headers: [
      { name: "CF-Access-Client-Id", value: "client-id" },
      { name: "CF-Access-Client-Secret", value: "client-secret" },
    ],
  });
  expect(restored?.input).toEqual({
    origin: (saved?.input as { origin: string } | undefined)?.origin,
    headers: [{ name: "X-Previous", value: "kept" }],
  });
});
