import { describe, expect, it } from "vite-plus/test";

import { markdownToSpeech, splitForSpeech } from "./speechText";

describe("markdownToSpeech", () => {
  it("drops markup, keeps link labels and replaces code blocks", () => {
    const markdown = [
      "## Result",
      "",
      "The **build** passed. See [the log](https://example.com/log) and `vp test`.",
      "",
      "```ts",
      "const secret = 1;",
      "```",
      "- first",
      "- second",
      "",
      "| Name | Value |",
      "|---|:---:|",
      "| rate | 2 |",
    ].join("\n");
    expect(markdownToSpeech(markdown)).toBe(
      [
        "Result",
        "The build passed. See the log and vp test.",
        "Code block.",
        "first second",
        "Name, Value rate, 2",
      ].join("\n\n"),
    );
  });

  it("keeps the alt text of an image", () => {
    expect(markdownToSpeech("Look: ![a chart](chart.png) here")).toBe("Look: a chart here");
  });
});

describe("splitForSpeech", () => {
  it("packs paragraphs up to the limit", () => {
    expect(splitForSpeech("one two\n\nthree\n\nfour five six", 14)).toEqual([
      "one two\n\nthree",
      "four five six",
    ]);
  });

  it("splits a long paragraph at a word end and never exceeds the limit", () => {
    const parts = splitForSpeech("alpha beta gamma delta epsilon", 12);
    expect(parts.every((part) => part.length <= 12)).toBe(true);
    expect(parts.join(" ")).toBe("alpha beta gamma delta epsilon");
  });
});
