import { describe, expect, it } from "vite-plus/test";

import { resolveVoicePreferences, sanitizeVoicePreferences } from "./forkVoicePreferences";

describe("sanitizeVoicePreferences", () => {
  it("keeps valid fields and drops invalid ones one by one", () => {
    expect(
      sanitizeVoicePreferences({
        assistantInput: "voice",
        assistantSendAfterVoice: "yes",
        assistantOpenThread: true,
        assistantProject: { environmentId: "env", projectId: "project" },
        readAloudRate: 3,
        readAloudThreads: [{ environmentId: "env", threadId: 4 }],
      }),
    ).toEqual({
      assistantInput: "voice",
      assistantOpenThread: true,
      assistantProject: { environmentId: "env", projectId: "project" },
    });
  });

  it("ignores a value that is not an object", () => {
    expect(sanitizeVoicePreferences("voice")).toBeUndefined();
    expect(sanitizeVoicePreferences(null)).toBeUndefined();
  });
});

describe("resolveVoicePreferences", () => {
  it("fills missing fields with the defaults", () => {
    const resolved = resolveVoicePreferences({ readAloudRate: 1.5 });
    expect(resolved.readAloudRate).toBe(1.5);
    expect(resolved.assistantInput).toBe("text");
    expect(resolved.readAloudButton).toBe(true);
    expect(resolved.assistantProject).toBeNull();
  });
});
