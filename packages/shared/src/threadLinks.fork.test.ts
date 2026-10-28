import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatThreadLink, parseThreadLinkHref } from "./threadLinks.ts";
import { threadLinkMessageId } from "./threadMessageLinks.ts";

describe("thread links", () => {
  it("copies a message destination without changing literal ids", () => {
    const ref = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread:mcp%3A1"),
    };
    const link = formatThreadLink(ref, "Message", "message:provider%3A2");
    expect(link).toBe("[Message](t3-thread://v2/env-1/thread:mcp%3A1#message:provider%3A2)");
    const href = link.slice("[Message](".length, -1);
    expect(parseThreadLinkHref(href)).toEqual(ref);
    expect(threadLinkMessageId(href)).toBe("message:provider%3A2");
    expect(parseThreadLinkHref("t3-thread://v1/t1#m1")).toEqual({
      environmentId: null,
      threadId: "t1",
    });
  });
});
