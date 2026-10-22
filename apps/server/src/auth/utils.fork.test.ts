import { describe, expect, it } from "vite-plus/test";

import { isForwardedRequest } from "./utils.ts";

describe("isForwardedRequest", () => {
  const request = (headers: Record<string, string>) =>
    ({ headers }) as unknown as Parameters<typeof isForwardedRequest>[0];

  it("treats a direct loopback request as local", () => {
    expect(isForwardedRequest(request({ host: "127.0.0.1:3773" }))).toBe(false);
    expect(isForwardedRequest(request({ host: "localhost:3773" }))).toBe(false);
    expect(isForwardedRequest(request({}))).toBe(false);
  });

  it("treats a cloudflared request from loopback as forwarded", () => {
    expect(
      isForwardedRequest(request({ host: "t3.example.com", "x-forwarded-for": "203.0.113.9" })),
    ).toBe(true);
    // A tunnel that rewrites Host to loopback still sends forwarding headers.
    expect(
      isForwardedRequest(request({ host: "127.0.0.1:3773", "cf-connecting-ip": "203.0.113.9" })),
    ).toBe(true);
    expect(isForwardedRequest(request({ host: "t3.example.com" }))).toBe(true);
  });
});
