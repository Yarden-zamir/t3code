import {
  AuthStandardClientScopes,
  type AuthSessionState,
  MACHINE_LEVEL_SCOPES,
  MachineId,
  type MachineDesiredState,
  type MachineLevel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createAccessChangeTracker } from "./accessChange.ts";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const MAC = MachineId.make("mac");
const VPS = MachineId.make("vps");

const session = (level: MachineLevel): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "t3_session",
  },
  scopes: [...MACHINE_LEVEL_SCOPES[level]],
  permissions: [...MACHINE_LEVEL_SCOPES[level]],
});
const REFUSED: AuthSessionState = { ...session("none"), authenticated: false };

const desired = (
  level: MachineLevel | null,
  options: { readonly agentTools?: boolean; readonly expiresAt?: string } = {},
): MachineDesiredState => ({
  revision: 1,
  self: {
    id: MAC,
    name: "Mac",
    kind: "laptop",
    tokenClientId: "mac-token",
    hostname: "t3-mac.example.com",
    position: { x: 0, y: 0 },
    mapRole: "read",
    createdAt: "2026-10-13T08:00:00.000Z",
  },
  peers: [
    { id: VPS, name: "VPS", kind: "server", hostname: "t3-vps.example.com", tokenClientId: "vps" },
  ],
  arrowsIn: [],
  arrowsOut:
    level === null
      ? []
      : [
          {
            from: MAC,
            to: VPS,
            level,
            agentTools: options.agentTools ?? true,
            exec: false,
            expiresAt: options.expiresAt ?? null,
            revertLevel: options.expiresAt === undefined ? null : "none",
          },
        ],
  settings: { server: {}, client: {} },
});

describe("access change notices: sessions", () => {
  it("names what a raised and a lowered arrow change", () => {
    const tracker = createAccessChangeTracker();
    expect(tracker.observeSession("vps", "VPS", session("read"))).toBeNull();
    expect(tracker.observeSession("vps", "VPS", session("standard"))).toEqual({
      title: "Access to VPS changed",
      description: "You can now send messages, use terminals and change settings.",
    });
    expect(tracker.observeSession("vps", "VPS", session("read"))?.description).toBe(
      "You can no longer send messages, use terminals and change settings.",
    );
  });

  it("stays quiet on a reconnect with the same scopes and in the gap of a refused session", () => {
    const tracker = createAccessChangeTracker();
    tracker.observeSession("vps", "VPS", session("standard"));
    expect(tracker.observeSession("vps", "VPS", REFUSED)).toBeNull();
    expect(tracker.observeSession("vps", "VPS", session("standard"))).toBeNull();
  });

  it("words a change outside the named abilities", () => {
    const tracker = createAccessChangeTracker();
    tracker.observeSession("vps", "VPS", session("standard"));
    const admin = {
      ...session("admin"),
      permissions: [...AuthStandardClientScopes],
      scopes: [...AuthStandardClientScopes],
    };
    expect(tracker.observeSession("vps", "VPS", admin)?.description).toBe(
      "Some permissions changed.",
    );
  });

  it("reports an ended arrow once, and the access that a restored arrow gives", () => {
    const tracker = createAccessChangeTracker();
    tracker.observeSession("vps", "VPS", session("standard"));
    expect(tracker.observeEnded("vps", "VPS")).toEqual({
      title: "Access to VPS ended",
      description: "Set the arrow in the portal to get it back.",
    });
    expect(tracker.observeEnded("vps", "VPS")).toBeNull();
    expect(tracker.observeSession("vps", "VPS", session("read"))?.description).toBe(
      "You can now see threads.",
    );
  });
});

describe("access change notices: agent links", () => {
  it("covers raise, lower, removal and restore of an arrow with agent tools", () => {
    const tracker = createAccessChangeTracker();
    expect(tracker.observeLinks("mac", desired("read"), NOW)).toEqual([]);
    expect(tracker.observeLinks("mac", desired("standard"), NOW)).toEqual([
      {
        title: "Access of agents on Mac to VPS changed",
        description: "They can now start threads there.",
      },
    ]);
    expect(tracker.observeLinks("mac", desired("read"), NOW)[0]?.description).toBe(
      "They can now only read threads there.",
    );
    expect(tracker.observeLinks("mac", desired(null), NOW)[0]?.description).toBe(
      "They can no longer reach VPS. Set the arrow in the portal to get it back.",
    );
    expect(tracker.observeLinks("mac", desired("admin"), NOW)[0]?.description).toBe(
      "They can now start and change any thread there.",
    );
  });

  it("treats agent tools off and an expired arrow as no link, and repeats nothing", () => {
    const tracker = createAccessChangeTracker();
    tracker.observeLinks("mac", desired("standard"), NOW);
    expect(tracker.observeLinks("mac", desired("standard"), NOW)).toEqual([]);
    expect(
      tracker.observeLinks("mac", desired("standard", { agentTools: false }), NOW),
    ).toHaveLength(1);
    tracker.observeLinks("mac", desired("standard"), NOW);
    const expired = desired("standard", { expiresAt: "2026-10-23T11:00:00.000Z" });
    expect(tracker.observeLinks("mac", expired, NOW)[0]?.description).toContain("no longer reach");
  });
});
