import { expect, it, vi } from "vite-plus/test";

vi.mock("expo-device", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

import { forkClientInviteAddress } from "./forkClientInvite";

it("accepts a kitshn device invite for Address without accepting general pairing deep links", () => {
  const invite = "https://kit.example.com/join/device#code=0123456789abcdef0123456789abcdef";
  expect(forkClientInviteAddress(invite)).toBe(invite);
  expect(forkClientInviteAddress("https://server.example.com/#token=abc")).toBeNull();
  expect(forkClientInviteAddress(undefined)).toBeNull();
});
