import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { newerForkRelease } from "./forkReleases.ts";

const release = (version: string, prerelease: boolean) => ({
  tag_name: `v${version}`,
  prerelease,
  assets: [{ name: "SHA256SUMS" }],
});

// Newest first, as the release index lists them.
const index = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json([
        release("1.0.0-nightly.20261029.3", true),
        release("1.0.0-nightly.20261029.2", false),
        release("1.0.0-nightly.20261029.1", true),
      ]),
    ),
  ),
);

it.effect("daily follows only the nightlies that the daily release promoted", () =>
  Effect.gen(function* () {
    const current = "1.0.0-nightly.20261029.1";
    expect(yield* newerForkRelease(index, current, "nightly")).toBe("1.0.0-nightly.20261029.3");
    expect(yield* newerForkRelease(index, current, "daily")).toBe("1.0.0-nightly.20261029.2");
    // A nightly newer than the newest daily stays: daily never installs an older build.
    expect(yield* newerForkRelease(index, "1.0.0-nightly.20261029.3", "daily")).toBeUndefined();
  }),
);
