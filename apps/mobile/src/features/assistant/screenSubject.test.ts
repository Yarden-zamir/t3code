import { describe, expect, it } from "vite-plus/test";

import {
  isoDurationSeconds,
  screenSubject,
  screenSubjectHeader,
  screenSubjectLabel,
  type ScreenReport,
} from "./screenSubject";

const report = (fields: Partial<ScreenReport>): ScreenReport => ({
  appLabel: null,
  sourcePackage: null,
  activityClass: null,
  webUri: null,
  structuredData: null,
  clipMimeType: null,
  clipLabel: null,
  isHomeApp: false,
  ...fields,
});

// The reports below are what real apps sent on a phone.
const youtube = report({
  appLabel: "YouTube ReVanced",
  sourcePackage: "app.revanced.android.youtube",
  activityClass: "com.google.android.apps.youtube.app.watchwhile.MainActivity",
  webUri: "https://www.youtube.com/watch?v=kzJrvNv3wBE",
  structuredData:
    '{"@videoId":"kzJrvNv3wBE","@videoHasCaptions":true,"@videoTimeStamp":"PT6M52.644S","@videoDuration":"PT37M49S"}',
});
const chrome = report({
  appLabel: "Chrome",
  sourcePackage: "com.android.chrome",
  activityClass: "org.chromium.chrome.browser.ChromeTabbedActivity",
  webUri: "https://www.theverge.com/ai-artificial-intelligence/1018217/reddit-opensource-ai-ban",
  structuredData: '{"page_metadata":{"is_work_profile":false}}',
});
const whatsapp = report({
  appLabel: "WhatsApp",
  sourcePackage: "com.whatsapp",
  activityClass: "com.whatsapp.Conversation",
  structuredData: '{"conversation_type":"Individual","conversation_id":"1@lid"}',
});
const launcher = report({
  appLabel: "System Launcher",
  sourcePackage: "com.android.launcher",
  activityClass: "com.android.launcher.Launcher",
  isHomeApp: true,
});

describe("screenSubject", () => {
  it("names the screen from what the app reported", () => {
    expect(screenSubjectLabel(screenSubject(youtube))).toBe("Video · YouTube ReVanced · 6:52");
    expect(screenSubjectLabel(screenSubject(chrome))).toBe("Page · theverge.com");
    expect(screenSubjectLabel(screenSubject(whatsapp))).toBe("Chat · WhatsApp");
    expect(screenSubjectLabel(screenSubject(launcher))).toBe("Home screen");
    expect(screenSubjectLabel(screenSubject(report({ appLabel: "Termux" })))).toBe(
      "Screen · Termux",
    );
  });

  it("links the video at the position the app reported", () => {
    const subject = screenSubject(youtube);
    expect(subject.type === "video" ? subject.linkAtPosition : null).toBe(
      "https://youtu.be/kzJrvNv3wBE?t=412",
    );
    expect(screenSubjectHeader(subject, youtube)).toContain(
      "Video: at 6:52 of 37:49, captions available",
    );
  });

  it("builds a position link only for YouTube", () => {
    const vimeo = screenSubject(
      report({
        webUri: "https://vimeo.com/1",
        structuredData: '{"@videoId":"1","@videoTimeStamp":"PT10S"}',
      }),
    );
    expect(vimeo.type === "video" ? vimeo.linkAtPosition : "not a video").toBeNull();
  });

  it("treats a chat app's link as a chat, not as a page", () => {
    // Telegram sends a t.me link for a public chat or channel.
    expect(screenSubject(report({ appLabel: "Telegram", webUri: "https://t.me/durov" })).type).toBe(
      "chat",
    );
    expect(
      screenSubjectLabel(
        screenSubject(
          report({ appLabel: "WhatsApp", structuredData: '{"conversation_type":"Group"}' }),
        ),
      ),
    ).toBe("Group chat · WhatsApp");
  });

  it("names music from the clip a player shares, and ignores bad structured data", () => {
    expect(
      screenSubjectLabel(
        screenSubject(
          report({ appLabel: "Gramophone", clipMimeType: "audio/mpeg", clipLabel: "Song" }),
        ),
      ),
    ).toBe("Music · Song");
    expect(screenSubject(report({ appLabel: "App", structuredData: "not json" })).type).toBe(
      "screen",
    );
    expect(screenSubject(report({ appLabel: "App", structuredData: '{"@videoId":""}' })).type).toBe(
      "screen",
    );
  });
});

describe("isoDurationSeconds", () => {
  it("reads hours, minutes and fractional seconds, and rejects other text", () => {
    expect(isoDurationSeconds("PT1H6M52.5S")).toBe(4012.5);
    expect(isoDurationSeconds("PT37M49S")).toBe(2269);
    expect(isoDurationSeconds("PT0S")).toBe(0);
    expect(isoDurationSeconds("PT")).toBeNull();
    expect(isoDurationSeconds(`PT${"9".repeat(400)}S`)).toBeNull();
    expect(isoDurationSeconds("P1D")).toBeNull();
    expect(isoDurationSeconds("PT5X")).toBeNull();
    expect(isoDurationSeconds(42)).toBeNull();
  });
});
