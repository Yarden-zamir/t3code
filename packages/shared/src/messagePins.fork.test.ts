import {
  MESSAGE_PIN_EXCERPT_MAX,
  MESSAGE_PINS_MAX,
  MessageId,
  ThreadId,
  type MessagePin,
  type PinnedMessages,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyMessagePinsPatch,
  messagePinExcerpt,
  messagePinKey,
  messagePinsNewestFirst,
  messagePinState,
  pinMessagePatch,
  unpinMessagePatch,
} from "./messagePins.ts";

const pin = (index: number, threadId = "mcp:thread:fork"): MessagePin => ({
  threadId: ThreadId.make(threadId),
  messageId: MessageId.make(`message:provider:${index}`),
  pinnedAt: `2026-10-25T00:00:00.${String(index).padStart(3, "0")}Z`,
  excerpt: `Message ${index}`,
  threadTitle: "Pins",
});

const pinsOf = (...entries: ReadonlyArray<MessagePin>): PinnedMessages =>
  Object.fromEntries(
    entries.map((entry) => [messagePinKey(entry.threadId, entry.messageId), entry]),
  );

describe("message pins", () => {
  it("adds and removes a pin by its thread and message ids", () => {
    const first = pin(1);
    const added = pinMessagePatch({}, first);
    expect(added._tag).toBe("Patch");
    if (added._tag !== "Patch") return;
    const pins = applyMessagePinsPatch({}, added.patch);
    expect(messagePinsNewestFirst(pins)).toEqual([first]);
    expect(applyMessagePinsPatch(pins, unpinMessagePatch(first))).toEqual({});
  });

  it("keeps one pin for each message of each thread", () => {
    const first = pin(1);
    expect(pinMessagePatch(pinsOf(first), { ...first, pinnedAt: pin(9).pinnedAt })._tag).toBe(
      "AlreadyPinned",
    );
    // The same message id in a forked thread is another pin.
    const forked = pin(1, "mcp:thread:fork:fork");
    const pins = applyMessagePinsPatch(pinsOf(first), {
      [messagePinKey(forked.threadId, forked.messageId)]: forked,
    });
    expect(messagePinsNewestFirst(pins)).toHaveLength(2);
  });

  it("refuses a pin at the cap and never drops a saved pin", () => {
    const full = pinsOf(...Array.from({ length: MESSAGE_PINS_MAX }, (_, index) => pin(index)));
    const extra = pin(MESSAGE_PINS_MAX);
    expect(pinMessagePatch(full, extra)._tag).toBe("Full");
    // A patch from a client that raced past the cap adds nothing.
    const merged = applyMessagePinsPatch(full, {
      [messagePinKey(extra.threadId, extra.messageId)]: extra,
    });
    expect(Object.keys(merged)).toHaveLength(MESSAGE_PINS_MAX);
    expect(merged).toEqual(full);
  });

  it("lists the newest pin first", () => {
    expect(
      messagePinsNewestFirst(pinsOf(pin(1), pin(3), pin(2))).map((entry) => entry.excerpt),
    ).toEqual(["Message 3", "Message 2", "Message 1"]);
  });

  it("marks a pin whose thread or message is gone, and only when it is known", () => {
    const first = pin(1);
    expect(messagePinState(first, { threadKnown: true, loadedMessageIds: null })).toBe("available");
    expect(messagePinState(first, { threadKnown: false, loadedMessageIds: null })).toBe(
      "thread-missing",
    );
    expect(
      messagePinState(first, { threadKnown: true, loadedMessageIds: new Set(["message:other"]) }),
    ).toBe("message-missing");
    expect(
      messagePinState(first, { threadKnown: true, loadedMessageIds: new Set([first.messageId]) }),
    ).toBe("available");
  });

  it("keeps a short one-line excerpt", () => {
    expect(messagePinExcerpt("  Fix the\n\nbug  ")).toBe("Fix the bug");
    const excerpt = messagePinExcerpt("word ".repeat(100));
    expect(excerpt.length).toBeLessThanOrEqual(MESSAGE_PIN_EXCERPT_MAX);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});
