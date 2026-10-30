import { expect, it } from "vite-plus/test";

import { kitshnEnvironmentLabel } from "./environmentLabel.ts";

it("uses the kitshn machine name only while the setting is on and kitshn named it", () => {
  expect(kitshnEnvironmentLabel("LT-HYPHCQL9RV", true, "Mac")).toBe("Mac");
  expect(kitshnEnvironmentLabel("LT-HYPHCQL9RV", false, "Mac")).toBe("LT-HYPHCQL9RV");
  expect(kitshnEnvironmentLabel("LT-HYPHCQL9RV", true, "  ")).toBe("LT-HYPHCQL9RV");
  expect(kitshnEnvironmentLabel("LT-HYPHCQL9RV", true, null)).toBe("LT-HYPHCQL9RV");
});
