import { describe, expect, it } from "vite-plus/test";

import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";

describe("normalizeDesktopUpdateReleaseNotes", () => {
  it("leaves collapsed screenshot blocks out of the changes", () => {
    const result = normalizeDesktopUpdateReleaseNotes(
      [
        "- **Feature** (#1): it matters.",
        "  <details><summary>Screenshots</summary>",
        "",
        '  <img src="https://example.com/a.png" alt="A shot" width="600">',
        "  ![Another shot](https://example.com/b.png)",
        "  </details>",
        "- **Fix** (#2): it works.",
      ].join("\n"),
      "0.1.2-nightly.20261021.1",
      "nightly",
    );
    expect(result.releaseNotes[0]?.items).toEqual([
      "Fix (#2): it works.",
      "Feature (#1): it matters.",
    ]);
  });
});
