import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { panelExchanges } from "./panelExchanges";

function run(id: string, status: "completed" | "failed" | "running", prompt: string) {
  return { id: RunId.make(id), status, userMessageId: MessageId.make(prompt) };
}

function reply(runId: string, messageId: string, text: string) {
  return {
    item: {
      type: "assistant_message",
      runId: RunId.make(runId),
      messageId: MessageId.make(messageId),
      text,
    },
  };
}

const sent = (messageId: string, text: string) => ({ messageId: MessageId.make(messageId), text });

describe("panelExchanges", () => {
  it("pairs each sent message with the replies of its own run only", () => {
    const exchanges = panelExchanges({
      projection: {
        runs: [
          run("history", "completed", "older-prompt"),
          run("a", "completed", "first"),
          run("b", "running", "second"),
        ],
        visibleTurnItems: [
          reply("history", "h-1", "not from the panel"),
          reply("a", "a-1", "done"),
          { item: { type: "tool_call", runId: RunId.make("b") } },
          reply("b", "b-1", "  "),
          reply("b", "b-2", "still going"),
        ],
      },
      sent: [sent("first", "fix it"), sent("second", "and test it")],
    });
    expect(exchanges).toEqual([
      {
        messageId: "first",
        text: "fix it",
        state: "done",
        replies: [{ messageId: "a-1", text: "done" }],
      },
      {
        messageId: "second",
        text: "and test it",
        state: "working",
        replies: [{ messageId: "b-2", text: "still going" }],
      },
    ]);
  });

  it("waits for a message the server has not started, and marks a failed run stopped", () => {
    const exchanges = panelExchanges({
      projection: { runs: [run("a", "failed", "first")], visibleTurnItems: [] },
      sent: [sent("first", "one"), sent("queued", "two")],
    });
    expect(exchanges.map((exchange) => exchange.state)).toEqual(["stopped", "working"]);
    expect(panelExchanges({ projection: null, sent: [sent("first", "one")] })[0]?.state).toBe(
      "working",
    );
  });
});
