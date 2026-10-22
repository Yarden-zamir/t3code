import { describe, expect, it } from "vite-plus/test";

import { formatThreadLink, formatThreadLinkHref, parseThreadLinkHref } from "./threadLinks.ts";
import { threadLinkMessageId } from "./threadMessageLinks.ts";

describe("thread links", () => {
  it("copies a message destination without changing literal ids", () => {
    const href = formatThreadLinkHref("thread:mcp%3A1", "message:provider%3A2");
    expect(href).toBe("t3-thread://v1/thread:mcp%3A1#message:provider%3A2");
    expect(parseThreadLinkHref(href)).toBe("thread:mcp%3A1");
    expect(threadLinkMessageId(href)).toBe("message:provider%3A2");
    expect(formatThreadLink("t1", "Message", "m1")).toBe("[Message](t3-thread://v1/t1#m1)");
    expect(formatThreadLinkHref("t1")).toBe("t3-thread://v1/t1");
  });
});
