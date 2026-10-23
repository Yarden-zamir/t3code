import { describe, expect, it } from "@effect/vitest";

import type { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { resolveDirectPairingBaseUrl } from "./pair.ts";

const baseState = {
  version: 1,
  pid: 123,
  port: 3_773,
  origin: "http://127.0.0.1:3773",
  startedAt: "2026-06-20T00:00:00.000Z",
} as const satisfies PersistedServerRuntimeState;

describe("pair base URL selection", () => {
  it("pairs through the tunnel URL of a loopback server with tunnel pairing on", () => {
    expect(
      resolveDirectPairingBaseUrl({ ...baseState, tunnelPairingUrl: "https://t3.example.com" }),
    ).toBe("https://t3.example.com");
  });
});
