import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";

describe("server browser snapshot timeouts", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  });
  afterEach(async () => {
    await context.close();
  });

  it.each(["metrics", "screenshot", "accessibility tree"] as const)(
    "identifies a timeout in %s without reporting the outer broker budget",
    async (stage) => {
      await page.setContent("<button>Capture</button>");
      const timeout = new Error("native operation did not answer");
      timeout.name = "TimeoutError";
      const send = cdp.send.bind(cdp);
      using _cdp = vi
        .spyOn(cdp, "send")
        .mockImplementation((method, ...args) =>
          stage === "metrics" || (stage === "screenshot" && method === "Page.captureScreenshot")
            ? Promise.reject(timeout)
            : send(method, ...args),
        );
      using _tree = vi.spyOn(page, "ariaSnapshot");
      if (stage === "accessibility tree") _tree.mockRejectedValue(timeout);
      await expect(
        ServerBrowserPage.snapshot({
          page,
          cdp,
          renderScale: stage === "metrics" ? "display" : 1,
          consoleEntries: [],
          networkEntries: [],
          actionTimeline: [],
        }),
      ).rejects.toMatchObject({
        tag: "PreviewAutomationTimeoutError",
        detail: { timeoutMs: 10_000, stage },
      });
    },
  );
});
