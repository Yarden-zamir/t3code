import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { parseKnownThreadAddress, parseThreadAddress, readThreadAppLink } from "./threadAddress.ts";
import { linkThreadMarkers } from "./threadMarkers.ts";

describe("parseThreadAddress", () => {
  it("reads web and app links, percent-decoded, with an optional message", () => {
    expect(parseThreadAddress("https://t3.example.com/env-1/mcp%3Aabc-1/")).toEqual({
      environmentId: "env-1",
      threadId: "mcp:abc-1",
    });
    expect(parseThreadAddress("t3code://threads/env-1/thread-1?message=msg-1")).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
      messageId: "msg-1",
    });
  });

  it("reads a message from the fragment, percent-decoded, and ignores app state there", () => {
    expect(parseThreadAddress("https://t3.example.com/env-1/thread-1#msg%3A1")).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
      messageId: "msg:1",
    });
    expect(parseThreadAddress("https://t3.example.com/env-1/thread-1#a=1")).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });
  });

  it("leaves other addresses alone", () => {
    expect(parseThreadAddress("https://t3.example.com/env-1/thread-1?prompt=hi")).toBeNull();
    expect(parseThreadAddress("t3code://threads/env-1/thread-1?prompt=hi")).toBeNull();
    expect(parseThreadAddress("t3code://new?prompt=hi")).toBeNull();
    expect(parseThreadAddress("https://t3.example.com/settings")).toBeNull();
    expect(parseThreadAddress("https://github.com/owner/repo/pull/1")).toBeNull();
    expect(parseThreadAddress("t3-thread://v1/thread-1")).toBeNull();
  });
});

describe("readThreadAppLink", () => {
  it.each([
    ["t3-thread://v2/env-1/thread-1", { environmentId: "env-1", threadId: "thread-1" }],
    [
      "t3-thread://v2/env-1/mcp%3Aabc-1#msg-1",
      { environmentId: "env-1", threadId: "mcp:abc-1", messageId: "msg-1" },
    ],
    [
      "t3-thread-dev://v2/env-2/thread-1#msg-1",
      { environmentId: "env-2", threadId: "thread-1", messageId: "msg-1" },
    ],
    [
      "t3code://threads/env-2/thread-1?message=msg-1",
      { environmentId: "env-2", threadId: "thread-1", messageId: "msg-1" },
    ],
    ["t3code-dev://threads/env-1/thread-1", { environmentId: "env-1", threadId: "thread-1" }],
  ])("reads %s", (href, address) => {
    expect(readThreadAppLink(href)).toEqual(address);
  });

  it.each([
    "t3-thread://v1/thread-1",
    "t3-thread://v3/env-1/thread-1",
    "t3-thread://v2/env-1",
    "t3-thread://v2/env-1/",
    "t3-thread://v2/env-1/thread-1/extra",
    "t3-thread://v2/env-1/thread-1?prompt=hi",
    "t3-thread://v2/%20/thread-1",
    "t3-threads://v2/env-1/thread-1",
    "t3code://threads/env-1/thread-1?prompt=hi",
    "t3code://new?prompt=hi",
    "https://t3.example.com/env-1/thread-1",
    "not a link",
  ])("rejects %s", (href) => {
    expect(readThreadAppLink(href)).toBeNull();
  });
});

describe("parseKnownThreadAddress", () => {
  it("reads a page with the same path shape as a thread only for a known environment", () => {
    const known = (id: string) => id === "env-1";
    expect(parseKnownThreadAddress("https://github.com/owner/repo", known)).toBeNull();
    expect(parseKnownThreadAddress("https://t3.example.com/env-1/thread-1", known)).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });
  });
});

describe("linkThreadMarkers", () => {
  it("links markers of attached threads outside code and keeps the rest", () => {
    const targets = new Map([
      [
        "ctx_1",
        { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") },
      ],
    ]);
    expect(
      linkThreadMarkers(
        "See [Thread: Fix; ref=ctx_1], `[Thread: Fix; ref=ctx_1]`, [Thread: Old; ref=ctx_9].",
        targets,
      ),
    ).toBe(
      "See [Fix](t3code://threads/env-1/thread-1), `[Thread: Fix; ref=ctx_1]`, [Thread: Old; ref=ctx_9].",
    );
  });
});
