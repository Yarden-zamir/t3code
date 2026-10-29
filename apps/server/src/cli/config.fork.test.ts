import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveCloudflareAccess, resolveTrustedBrowserOrigins } from "./config.ts";

it.effect("accepts trusted browser origins as comma or newline separated https origins", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* resolveTrustedBrowserOrigins(undefined), []);
    assert.deepEqual(
      yield* resolveTrustedBrowserOrigins(
        " https://t3-mac.example.com/,\nhttps://t3-vps.example.com ",
      ),
      ["https://t3-mac.example.com", "https://t3-vps.example.com"],
    );
  }),
);

it.effect("rejects a trusted browser origin that is not a bare https origin", () =>
  Effect.gen(function* () {
    for (const raw of [
      "http://t3.example.com",
      "https://t3.example.com/path",
      "t3.example.com",
      "https://t3.example.com, *",
    ]) {
      const error = yield* Effect.flip(resolveTrustedBrowserOrigins(raw));
      assert.include(String(error.cause), "T3CODE_TRUSTED_BROWSER_ORIGINS");
    }
  }),
);

it.effect("turns the Access check on only when both values are set", () =>
  Effect.gen(function* () {
    const none = { teamDomain: undefined, aud: undefined };
    assert.strictEqual(yield* resolveCloudflareAccess(none), undefined);
    assert.deepEqual(
      yield* resolveCloudflareAccess({ teamDomain: "team.cloudflareaccess.com", aud: "aud-tag" }),
      { teamDomain: "team.cloudflareaccess.com", aud: "aud-tag" },
    );
    for (const partial of [
      { ...none, teamDomain: "team.cloudflareaccess.com" },
      { ...none, aud: "aud-tag" },
      { teamDomain: "https://team.cloudflareaccess.com", aud: "aud-tag" },
    ]) {
      const error = yield* Effect.flip(resolveCloudflareAccess(partial));
      assert.include(String(error.cause), "T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN");
    }
  }),
);
