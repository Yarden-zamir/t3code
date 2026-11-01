import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { preflightAnswer } from "./ElectronRequestHeaders.ts";

const APP = "t3code://app";
const rules = [
  { origin: "https://t3.example.com", headers: [{ name: "CF-Access-Client-Id", value: "id" }] },
];
const preflight = {
  method: "OPTIONS",
  url: "https://t3.example.com/oauth/token",
  requestHeaders: {
    Origin: APP,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization,traceparent",
  },
  appOrigin: APP,
  rules,
};

describe("preflightAnswer", () => {
  it("answers the app's preflight to an origin with rules with only what it asked for", () => {
    expect(preflightAnswer(preflight)).toEqual({
      "Access-Control-Allow-Origin": [APP],
      "Access-Control-Allow-Methods": ["POST"],
      "Access-Control-Allow-Headers": ["authorization,traceparent"],
      Vary: ["Origin"],
    });
  });

  it.each([
    [
      "another page",
      { requestHeaders: { ...preflight.requestHeaders, Origin: "https://evil.example" } },
    ],
    [
      "the dev page in a packaged build",
      { requestHeaders: { ...preflight.requestHeaders, Origin: "t3code-dev://app" } },
    ],
    ["a real request", { method: "POST" }],
    ["an OPTIONS request that is no preflight", { requestHeaders: { Origin: APP } }],
    ["an origin without rules", { url: "https://other.example.com/oauth/token" }],
  ])("passes %s through", (_name, change) => {
    expect(preflightAnswer({ ...preflight, ...change })).toBeNull();
  });
});
