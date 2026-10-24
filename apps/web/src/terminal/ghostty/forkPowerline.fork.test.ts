import { describe, expect, it } from "vite-plus/test";

import { forkPowerlineText } from "./forkPowerline";

describe("forkPowerlineText", () => {
  it("leaves a space where the fork draws an outline or a half circle", () => {
    expect(forkPowerlineText("")).toBe(" ");
    expect(forkPowerlineText("")).toBe(" ");
  });

  it("keeps text and the solid triangles, which the renderer draws itself", () => {
    expect(forkPowerlineText("a")).toBe("a");
    expect(forkPowerlineText("")).toBe("");
    expect(forkPowerlineText("")).toBe("");
  });
});
