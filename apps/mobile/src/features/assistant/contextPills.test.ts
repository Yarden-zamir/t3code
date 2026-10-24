import { describe, expect, it } from "vite-plus/test";

import {
  contextPillLabel,
  locationText,
  inlineContextText,
  joinMessageText,
  screenTextDocument,
} from "./contextPills";

describe("context pills", () => {
  it("labels each pill from its value", () => {
    expect(contextPillLabel("screenText", "one\n\ntwo\nthree")).toBe("Screen text · 3 lines");
    expect(contextPillLabel("selection", "short")).toBe("“short”");
    expect(contextPillLabel("selection", "a selection that is longer than the label")).toBe(
      "“a selection that is long…”",
    );
    expect(contextPillLabel("link", "https://example.com/a/b?c=1")).toBe("example.com");
    expect(contextPillLabel("link", "not a url")).toBe("not a url");
  });

  it("quotes the selection and the clipboard, and skips empty context", () => {
    expect(
      inlineContextText({
        sharedText: null,
        selection: "line one\nline two",
        link: "https://x.dev",
        location: null,
        clipboard: "  ",
      }),
    ).toBe("Link: https://x.dev\n\nSelected text:\n> line one\n> line two");
    expect(
      inlineContextText({
        sharedText: null,
        selection: null,
        link: null,
        location: null,
        clipboard: null,
      }),
    ).toBe("");
  });

  it("joins the message with its context, and heads the screen text with its app", () => {
    expect(joinMessageText("  fix this ", "Link: https://x.dev")).toBe(
      "fix this\n\nLink: https://x.dev",
    );
    expect(joinMessageText("", "Link: https://x.dev")).toBe("Link: https://x.dev");
    expect(screenTextDocument("com.android.chrome", "body")).toBe(
      "App: com.android.chrome\n\nbody",
    );
    expect(screenTextDocument(null, "body")).toBe("body");
  });

  it("writes the location with its place, or the coordinates alone", () => {
    const text = locationText({
      latitude: 32.085301,
      longitude: 34.781769,
      accuracyMeters: 1203.4,
      place: "Tel Aviv, Israel",
    });
    expect(text).toBe("Tel Aviv, Israel (32.08530, 34.78177, ±1203 m)");
    expect(contextPillLabel("location", text)).toBe("Tel Aviv, Israel");
    expect(locationText({ latitude: 1, longitude: 2, accuracyMeters: 30, place: null })).toBe(
      "1.00000, 2.00000, ±30 m",
    );
  });
});
