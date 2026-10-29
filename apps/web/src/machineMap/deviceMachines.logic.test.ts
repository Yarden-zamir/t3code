import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planDeviceMachines, type SavedEnvironment } from "./deviceMachines.logic";

const VPS = "https://t3-vps.example.com";
const MAC = "https://t3-mac.example.com";

const saved = (
  origin: string,
  phase: SavedEnvironment["phase"] = "connected",
): SavedEnvironment => ({
  environmentId: EnvironmentId.make(origin),
  origin,
  phase,
});

describe("planDeviceMachines", () => {
  it("pairs a new or refused managed machine and leaves a hand-saved one alone", () => {
    expect(
      planDeviceMachines({
        listed: [VPS, MAC],
        managed: new Set([VPS]),
        saved: [saved(VPS, "error"), saved(MAC)],
      }),
    ).toEqual({ keep: [VPS], pair: [VPS], remove: [] });
  });

  it("removes a managed machine that the list dropped, but nothing for an empty list", () => {
    const managed = new Set([VPS, MAC]);
    expect(
      planDeviceMachines({ listed: [VPS], managed, saved: [saved(VPS), saved(MAC)] }).remove,
    ).toEqual([{ origin: MAC, environmentId: EnvironmentId.make(MAC) }]);
    expect(planDeviceMachines({ listed: [], managed, saved: [saved(VPS)] }).remove).toEqual([]);
  });
});
