import { MachineId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { machineOfRequestNamespace, machineRequestNamespace } from "./machineAccess.ts";
import { linkTargets } from "./MachinePeers.ts";

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
        origin: "http://link/vps",
        access: "auto",
        exec: true,
      },
      // Exec also needs t3.app at use or control.
      {
        machine: { id: "oracle", name: "ORACLE" },
        origin: "http://link/oracle",
        access: "read-only",
        exec: false,
      },
    ]);
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
