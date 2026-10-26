import { expect, it } from "vite-plus/test";

import { normalizeGuestRules } from "./guestLinks.ts";

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
        ipRanges: ["10.0.0.0/8", "2001:db8::/32", "192.0.2.7"],
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
  ]) {
    expect(normalizeGuestRules(bad)).toHaveProperty("error");
  }
});
