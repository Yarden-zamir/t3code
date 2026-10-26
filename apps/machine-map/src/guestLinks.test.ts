import { expect, it } from "vite-plus/test";

import { guestHostProblem, normalizeGuestRules } from "./guestLinks.ts";

const rules = (overrides: Partial<Parameters<typeof normalizeGuestRules>[0]>) => ({
  emails: [],
  emailDomains: [],
  ipRanges: [],
  requireIpRanges: [],
  ...overrides,
});

it("keeps valid guest rules in one form and refuses what Cloudflare would refuse", () => {
  expect(
    normalizeGuestRules(
      rules({
        emails: ["A@Example.com", "a@example.com"],
        emailDomains: ["@Qlik.com"],
        ipRanges: ["10.1.2.3/8", "2001:DB8::/32", "192.0.2.7"],
      }),
    ),
  ).toEqual({
    rules: rules({
      emails: ["a@example.com"],
      emailDomains: ["qlik.com"],
      ipRanges: ["10.0.0.0/8", "2001:db8::/32", "192.0.2.7/32"],
    }),
  });
  for (const bad of [
    rules({ emails: ["not-an-email"] }),
    rules({ emailDomains: ["a@b.com"] }),
    rules({ ipRanges: ["10.0.0.0/33"] }),
    rules({ requireIpRanges: ["300.0.0.1"] }),
    rules({ ipRanges: ["10.0.0.0/8/1"] }),
    rules({ ipRanges: [":::::"] }),
    rules({ requireIpRanges: ["10.0.0.0/8"] }),
  ]) {
    expect(normalizeGuestRules(bad)).toHaveProperty("error");
  }
});

it("lets guest apps only on a plain host of the machine zone that no one else claims", () => {
  const check = (host: string, others: ReadonlyArray<string> = []) =>
    guestHostProblem(host, "example.com", "t3.example.com", others);
  expect(check("t3-vps.example.com")).toBeNull();
  for (const bad of ["t3.example.com", "*.example.com", "t3-vps.example.com/api", "evil.org"])
    expect(check(bad), bad).not.toBeNull();
  expect(check("t3-vps.example.com", ["T3-VPS.example.com"])).not.toBeNull();
});
