import { describe, expect, it } from "vite-plus/test";

import { repositoryOwnerOf } from "./environment.ts";

describe("repositoryOwnerOf", () => {
  const locator = { source: "git-remote" as const, remoteName: "origin", remoteUrl: "x" };

  it("reads a fork as its own owner for grouping, and as the upstream owner for pull requests", () => {
    const fork = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator,
      origin: { canonicalKey: "github.com/yarden-zamir/t3code" },
    };
    expect(repositoryOwnerOf(fork, "grouping")).toBe("yarden-zamir");
    expect(repositoryOwnerOf(fork, "canonical")).toBe("pingdotgg");
  });

  it("is null without an identity or an owner segment", () => {
    expect(repositoryOwnerOf({ canonicalKey: "local-only", locator }, "grouping")).toBeNull();
    expect(repositoryOwnerOf(null, "canonical")).toBeNull();
  });
});
