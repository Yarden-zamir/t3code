import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveTrustedBrowserOrigins } from "./config.ts";

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
