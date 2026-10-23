import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectScript } from "./project.ts";

describe("ProjectScript", () => {
  const decodeProjectScript = Schema.decodeUnknownSync(ProjectScript);
  const encodeProjectScript = Schema.encodeSync(ProjectScript);
  const base = {
    id: "nav",
    name: "Navgator",
    command: "bash nav.sh",
    icon: "play" as const,
    runOnWorktreeCreate: false,
  };

  it("accepts runInBackground and keeps an absent value absent", () => {
    expect(decodeProjectScript({ ...base, runInBackground: true }).runInBackground).toBe(true);
    expect("runInBackground" in decodeProjectScript(base)).toBe(false);
  });

  it("round-trips an optional global shortcut without adding it to legacy scripts", () => {
    const script = { ...base, globalShortcut: "CommandOrControl+Alt+N" };
    expect(decodeProjectScript(script)).toEqual(script);
    expect(encodeProjectScript(script)).toEqual(script);
    expect(decodeProjectScript(base)).not.toHaveProperty("globalShortcut");
    expect(() => decodeProjectScript({ ...base, globalShortcut: " " })).toThrow();
  });
});
