import { describe, expect, it } from "vite-plus/test";

import { buildProjectScript, shouldShowScriptTerminal } from "./projectScripts";

describe("projectScripts helpers", () => {
  const backgroundInput = {
    name: "Navgator",
    command: "bash navgator.sh",
    icon: "play",
    runOnWorktreeCreate: false,
    waitForSetup: false,
    runOnSettle: false,
    previewUrl: null,
    autoOpenPreview: false,
    previewOverlay: false,
  } as const;

  it("stores runInBackground only when it is on", () => {
    const on = buildProjectScript("nav", { ...backgroundInput, runInBackground: true });
    expect(on.runInBackground).toBe(true);
    const off = buildProjectScript("nav", { ...backgroundInput, runInBackground: false });
    expect("runInBackground" in off).toBe(false);
  });

  it("saves, preserves and clears an optional global accelerator", () => {
    const input = { ...backgroundInput, runInBackground: false };
    const saved = buildProjectScript("nav", { ...input, globalShortcut: "F18" });
    expect(saved.globalShortcut).toBe("F18");
    const edited = buildProjectScript("nav", {
      ...input,
      globalShortcut: saved.globalShortcut ?? null,
      name: "Navigator",
    });
    expect(edited.globalShortcut).toBe("F18");
    expect(buildProjectScript("nav", { ...input, globalShortcut: null })).not.toHaveProperty(
      "globalShortcut",
    );
    expect(buildProjectScript("nav", input)).not.toHaveProperty("globalShortcut");
  });

  it("shows the terminal drawer unless the script runs in background", () => {
    const script = buildProjectScript("nav", { ...backgroundInput, runInBackground: false });
    expect(shouldShowScriptTerminal(script)).toBe(true);
    expect(shouldShowScriptTerminal({ ...script, runInBackground: false })).toBe(true);
    expect(shouldShowScriptTerminal({ ...script, runInBackground: true })).toBe(false);
  });

  it("stores previewOverlay only with a preview URL and only when it is on", () => {
    const input = {
      name: "Navgator",
      command: "navgator web --no-open",
      icon: "play",
      runOnWorktreeCreate: false,
      waitForSetup: false,
      runOnSettle: false,
      autoOpenPreview: true,
      runInBackground: true,
    } as const;
    const overlay = buildProjectScript("nav", {
      ...input,
      previewUrl: "http://127.0.0.1:4748",
      previewOverlay: true,
    });
    expect(overlay.previewOverlay).toBe(true);
    const noUrl = buildProjectScript("nav", { ...input, previewUrl: null, previewOverlay: true });
    expect("previewOverlay" in noUrl).toBe(false);
  });
});
