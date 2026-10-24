import { describe, expect, it } from "vite-plus/test";

import { formatThreadLink, parseThreadLinkHref, relabelThreadLinks } from "./threadLinks.ts";
import {
  isLinkedMessage,
  messageLinkFromLocation,
  messageLinkStep,
  threadLinkMessageId,
} from "./threadMessageLinks.ts";

describe("message links", () => {
  it("reads the thread and the message of a link with and without a fragment", () => {
    expect(parseThreadLinkHref("t3-thread://v1/mcp:1")).toBe("mcp:1");
    expect(threadLinkMessageId("t3-thread://v1/mcp:1")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/mcp:1#msg:2")).toBe("mcp:1");
    expect(threadLinkMessageId("t3-thread://v1/mcp:1#msg:2")).toBe("msg:2");
    expect(parseThreadLinkHref("t3-thread://v1/mcp:1#")).toBe("mcp:1");
    expect(threadLinkMessageId("t3-thread://v1/mcp:1#")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/#msg")).toBeNull();
  });

  it("keeps a message id as written and matches its percent-decoded form", () => {
    expect(threadLinkMessageId("t3-thread://v1/t1#msg%3A2")).toBe("msg%3A2");
    expect(isLinkedMessage("msg%3A2", "msg:2")).toBe(true);
    expect(isLinkedMessage("msg%3A2", "msg%3A2")).toBe(true);
    expect(isLinkedMessage("msg%3A2", "msg:3")).toBe(false);
    expect(isLinkedMessage("bad%", "bad%")).toBe(true);
    expect(isLinkedMessage("bad%", "bad")).toBe(false);
  });

  it("reads no message from app state in the fragment", () => {
    expect(threadLinkMessageId("t3-thread://v1/t1#assistant-citation=abc")).toBeNull();
  });

  it("formats and relabels a link with its message", () => {
    expect(formatThreadLink("t1", "Fix", "m1")).toBe("[Fix](t3-thread://v1/t1#m1)");
    expect(relabelThreadLinks("[Old](t3-thread://v1/t1#m1)", () => "New")).toBe(
      "[New](t3-thread://v1/t1#m1)",
    );
  });
});

describe("messageLinkFromLocation", () => {
  it("reads the fragment first, then the message query param", () => {
    expect(messageLinkFromLocation("m1", "")).toBe("m1");
    expect(messageLinkFromLocation("m1", "?message=m2")).toBe("m1");
    expect(messageLinkFromLocation("", "?message=msg%3A2")).toBe("msg:2");
    expect(messageLinkFromLocation("", "")).toBeNull();
  });

  it("reads no message from a fragment that holds app state", () => {
    expect(messageLinkFromLocation("assistant-citation=abc", "")).toBeNull();
  });
});

describe("messageLinkStep", () => {
  const missingFromLoadedPage = {
    synced: true,
    historyLoading: false,
    shown: false,
    loaded: false,
    canExpand: false,
    hasMoreHistory: true,
    historyExhausted: false,
  };

  it("waits for the sync and any history load before it decides", () => {
    expect(messageLinkStep({ ...missingFromLoadedPage, synced: false })).toBe("wait");
    expect(messageLinkStep({ ...missingFromLoadedPage, historyLoading: true })).toBe("wait");
    expect(messageLinkStep({ ...missingFromLoadedPage, shown: true, synced: false })).toBe("wait");
  });

  it("scrolls to a shown message", () => {
    expect(messageLinkStep({ ...missingFromLoadedPage, shown: true })).toBe("scroll");
  });

  it("opens the fold that hides a loaded message once, then reports it missing", () => {
    expect(messageLinkStep({ ...missingFromLoadedPage, loaded: true, canExpand: true })).toBe(
      "expand",
    );
    expect(messageLinkStep({ ...missingFromLoadedPage, loaded: true })).toBe("missing");
  });

  it("loads earlier history until it runs out, then reports the message missing", () => {
    expect(messageLinkStep(missingFromLoadedPage)).toBe("load");
    expect(messageLinkStep({ ...missingFromLoadedPage, hasMoreHistory: false })).toBe("missing");
    expect(messageLinkStep({ ...missingFromLoadedPage, historyExhausted: true })).toBe("missing");
  });
});
