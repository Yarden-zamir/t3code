import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentThemeFile } from "./server.ts";

describe("EnvironmentThemeFile style fields", () => {
  const decodeThemeFile = Schema.decodeUnknownExit(EnvironmentThemeFile);
  const base = { name: "Neo", appearance: "light", canvas: "#ffffff", accent: "#000000" };

  it("accepts every style field", () => {
    const exit = decodeThemeFile({
      ...base,
      radius: "0",
      borderWidth: "2.5px",
      shadow: "4px 4px 0 0 #000",
      fonts: { sans: "Bricolage Grotesque", terminal: "JetBrainsMono Nerd Font Mono" },
      canvasPattern: "grid",
      canvasPatternColor: "#00000022",
    });
    expect(exit._tag).toBe("Success");
  });

  it("accepts an icon pack of SVGs and rejects a value that is not an SVG", () => {
    const svg = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/></svg>';
    expect(
      decodeThemeFile({ ...base, icons: { "tab.star": svg, "status.working": svg } })._tag,
    ).toBe("Success");
    expect(decodeThemeFile({ ...base, icons: { "tab.star": "<img src=x>" } })._tag).toBe(
      "Failure",
    );
  });

  it("leaves every style field absent when the file has none", () => {
    const exit = decodeThemeFile(base);
    expect(exit._tag).toBe("Success");
    if (exit._tag !== "Success") return;
    for (const key of ["radius", "borderWidth", "shadow", "fonts", "canvasPattern"] as const) {
      expect(exit.value[key]).toBeUndefined();
    }
  });

  it.each([
    { radius: "10%" },
    { radius: "big" },
    { borderWidth: "-1px" },
    { shadow: "0 0 red; color: red" },
    { shadow: "}" },
    { fonts: { sans: "" } },
    { canvasPattern: "stripes" },
  ])("rejects %j", (fields) => {
    expect(decodeThemeFile({ ...base, ...fields })._tag).toBe("Failure");
  });
});
