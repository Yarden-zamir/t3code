import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerThreadItems, readableThreadEnvironments } from "./composerThreadItems.ts";

const LOCAL = EnvironmentId.make("env-local");
const PEER = EnvironmentId.make("env-peer");
const OTHER = EnvironmentId.make("env-other");

const shell = (environmentId: EnvironmentId, id: string, updatedAt: string) => ({
  environmentId,
  id: ThreadId.make(id),
  title: `Fix ${id}`,
  updatedAt,
  archivedAt: null,
});

const shells = [
  shell(LOCAL, "local", "2026-10-01T00:00:00.000Z"),
  shell(PEER, "peer", "2026-10-02T00:00:00.000Z"),
  shell(OTHER, "other", "2026-10-03T00:00:00.000Z"),
];

describe("matchComposerThreadItems", () => {
  it("lists threads of readable machines and names each machine (MM-1907)", () => {
    const readable = readableThreadEnvironments(LOCAL, [
      { environmentId: LOCAL, name: "Mac" },
      { environmentId: PEER, name: "VPS" },
    ]);
    const items = matchComposerThreadItems({
      shells,
      readable,
      excludeThreadId: null,
      query: "fix",
    });
    expect(items.map((item) => [item.thread.environmentId, item.description])).toEqual([
      [PEER, "Thread · VPS"],
      [LOCAL, "Thread · Mac"],
    ]);
  });

  it("stays on the composer's machine when its server names no other machine", () => {
    const items = matchComposerThreadItems({
      shells,
      readable: readableThreadEnvironments(LOCAL, null),
      excludeThreadId: null,
      query: "fix",
    });
    expect(items.map((item) => [item.thread.environmentId, item.description])).toEqual([
      [LOCAL, "Thread"],
    ]);
  });
});
