import { describe, expect, it } from "vite-plus/test";

import {
  CLI_RELEASES_PAGE_URL,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
} from "./cliRelease.ts";

// Fork: servers, `t3 update` and the mobile update check read the fork releases.
describe("fork release repository", () => {
  it("points every release URL at the fork", () => {
    expect(CLI_RELEASES_PAGE_URL).toBe("https://github.com/Yarden-zamir/t3code/releases");
    expect(cliReleaseIndexPageUrl(2)).toBe(
      "https://api.github.com/repos/Yarden-zamir/t3code/releases?per_page=100&page=2",
    );
    expect(cliReleaseDownloadBaseUrl("1.2.3")).toBe(
      "https://github.com/Yarden-zamir/t3code/releases/download/v1.2.3",
    );
  });
});
