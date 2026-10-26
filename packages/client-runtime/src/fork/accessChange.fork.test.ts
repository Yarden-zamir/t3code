import {
  type AuthSessionState,
  MACHINE_LEVEL_SCOPES,
  MachineId,
  type MachineMapClientState,
  type MachineLevel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createAccessChangeTracker } from "./accessChange.ts";

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

const VPS_PEER = {
  id: VPS,
  name: "VPS",
  kind: "server",
  hostname: "t3-vps.example.com",
  tokenClientId: "vps",
} as const;

/** The map state that the Mac server pushes, with its reachable machines (MM-306). */
const mapState = (
  level: MachineLevel | null,
  options: { readonly agentTools?: boolean } = {},
): Pick<MachineMapClientState, "desired" | "reachable"> => ({
  desired: {
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
    peers: [VPS_PEER],
    arrowsIn: [],
    arrowsOut: [],
    settings: { server: {}, client: {} },
  },
  reachable:
    level === null || level === "none"
      ? []
      : [
          {
            machine: VPS_PEER,
            level,
            agentTools: options.agentTools ?? true,
            origin: "https://t3-vps.example.com",
          },
        ],
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

  it("names the access management that admin adds to standard", () => {
    const tracker = createAccessChangeTracker();
    tracker.observeSession("vps", "VPS", session("standard"));
    expect(tracker.observeSession("vps", "VPS", session("admin"))?.description).toBe(
      "You can now manage access and manage T3 Connect.",
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
    expect(tracker.observeLinks("mac", mapState("read"))).toEqual([]);
    expect(tracker.observeLinks("mac", mapState("standard"))).toEqual([
      {
        title: "Access of agents on Mac to VPS changed",
        description: "They can now start threads there.",
      },
    ]);
    expect(tracker.observeLinks("mac", mapState("read"))[0]?.description).toBe(
      "They can now only read threads there.",
    );
    expect(tracker.observeLinks("mac", mapState(null))[0]?.description).toBe(
      "They can no longer reach VPS. Set the arrow in the portal to get it back.",
    );
    expect(tracker.observeLinks("mac", mapState("admin"))[0]?.description).toBe(
      "They can now start and change any thread there.",
    );
  });

  it("repeats nothing, and treats agent tools off as no link", () => {
    const tracker = createAccessChangeTracker();
    tracker.observeLinks("mac", mapState("standard"));
    expect(tracker.observeLinks("mac", mapState("standard"))).toEqual([]);
    expect(tracker.observeLinks("mac", mapState("standard", { agentTools: false }))).toHaveLength(
      1,
    );
  });

  it("starts again after notices were off, and skips a state without a desired state", () => {
    const tracker = createAccessChangeTracker();
    tracker.observeLinks("mac", mapState("read"));
    tracker.forgetLinks("mac");
    expect(tracker.observeLinks("mac", mapState("admin"))).toEqual([]);
    expect(tracker.observeLinks("mac", { desired: null, reachable: [] })).toEqual([]);
    expect(tracker.observeLinks("mac", mapState("admin"))).toEqual([]);
  });
});
