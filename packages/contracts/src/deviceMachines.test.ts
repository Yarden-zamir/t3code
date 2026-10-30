import { describe, expect, it } from "vite-plus/test";

import { deviceMachinesUrl, MachineId, t3AppMachines } from "./machineMap.ts";

describe("device machine list (K-1601)", () => {
  it("asks kitshn of the zone of a T3 host", () => {
    expect(deviceMachinesUrl("https://t3-vps.example.com")).toBe(
      "https://kit.example.com/device/machines",
    );
    expect(deviceMachinesUrl("http://localhost:3773")).toBeNull();
  });

  it("keeps only the T3 app cards, in the shape of the portal list", () => {
    const machine = (kind: string) => ({
      id: MachineId.make("vps"),
      name: "VPS",
      origin: "https://t3-vps.example.com",
      card: "c1",
      kind,
      level: "use",
    });
    expect(t3AppMachines({ machines: [machine("t3.app"), machine("t3.agents")] })).toEqual({
      machines: [{ id: "vps", name: "VPS", origin: "https://t3-vps.example.com" }],
    });
  });
});
