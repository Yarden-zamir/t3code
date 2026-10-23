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

  it("shows the breaking changes warning of a fork daily release first", () => {
    const result = normalizeDesktopUpdateReleaseNotes(
      [
        "## ⚠️ Breaking changes",
        "",
        "- [#295](https://github.com/Yarden-zamir/t3code/pull/295) **refactor(fork)!: sidebar groups become sidebar tabs**: keys move once.",
        "",
        "Daily release of fork main.",
        "",
        "## Fork changes and additions",
        "",
        "- **Tabs** ([#295](https://github.com/Yarden-zamir/t3code/pull/295)): groups become tabs.",
        "",
        '⚠️ Breaking changes: [#295](https://github.com/Yarden-zamir/t3code/pull/295). Read "Breaking changes" at the top before you update.',
        "",
        "## Full changelog",
        "",
        "- not shown",
      ].join("\n"),
      "0.1.3-nightly.20261023.1",
      "nightly",
    );
    expect(result.releaseNotes[0]?.items[0]).toBe(
      '⚠️ Breaking changes: #295. Read "Breaking changes" at the top before you update.',
    );
  });
});
