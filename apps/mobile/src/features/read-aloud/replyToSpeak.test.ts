import { MessageId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { replyToSpeak } from "./replyToSpeak";

const at = (ms: number) => DateTime.makeUnsafe(ms);

function run(id: string, status: "completed" | "failed" | "running", completedMs: number | null) {
  return {
    id: RunId.make(id),
    status,
    userMessageId: MessageId.make(`${id}-prompt`),
    requestedAt: at(0),
    completedAt: completedMs === null ? null : at(completedMs),
  };
}

function reply(runId: string, messageId: string, text: string, streaming = false) {
  return {
    item: {
      type: "assistant_message",
      runId: RunId.make(runId),
      messageId: MessageId.make(messageId),
      text,
      streaming,
    },
  };
}

describe("replyToSpeak", () => {
  it("reads the last reply of the newest run that completed after the start", () => {
    const result = replyToSpeak({
      projection: {
        runs: [
          run("old", "completed", 100),
          run("a", "completed", 2_000),
          run("b", "completed", 3_000),
        ],
        visibleTurnItems: [
          reply("a", "a-1", "first"),
          reply("b", "b-1", "working on it"),
          reply("b", "b-2", "done"),
        ],
      },
      after: { sinceMs: 1_000 },
      handledRunIds: new Set(),
    });
    expect(result.reply).toEqual({ messageId: "b-2", text: "done" });
    // The older run is settled too, so it is never read after the newer one.
    expect(result.settledRunIds).toEqual(["a", "b"]);
  });

  it("skips failed, running and handled runs, and a reply that still streams", () => {
    const result = replyToSpeak({
      projection: {
        runs: [
          run("failed", "failed", 2_000),
          run("running", "running", null),
          run("done", "completed", 2_000),
        ],
        visibleTurnItems: [reply("done", "done-1", "partial", true)],
      },
      after: { sinceMs: 1_000 },
      handledRunIds: new Set([RunId.make("other")]),
    });
    // The run waits until its reply stops streaming.
    expect(result).toEqual({ settledRunIds: [], reply: null });
    expect(
      replyToSpeak({
        projection: { runs: [run("done", "completed", 2_000)], visibleTurnItems: [] },
        after: { sinceMs: 1_000 },
        handledRunIds: new Set([RunId.make("done")]),
      }).settledRunIds,
    ).toEqual([]);
  });

  it("reads only the run of the sent message when it names one", () => {
    const result = replyToSpeak({
      projection: {
        runs: [run("earlier", "completed", 5_000), run("mine", "completed", 4_000)],
        visibleTurnItems: [reply("earlier", "e-1", "other work"), reply("mine", "m-1", "my reply")],
      },
      after: { userMessageId: MessageId.make("mine-prompt") },
      handledRunIds: new Set(),
    });
    expect(result).toEqual({
      settledRunIds: ["mine"],
      reply: { messageId: "m-1", text: "my reply" },
    });
  });
});
