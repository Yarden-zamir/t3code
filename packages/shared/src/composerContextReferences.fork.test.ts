import type { ComposerContextId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectComposerContextForProvider } from "./composerContextReferences.ts";

describe("fork machine mentions", () => {
  it("tells the agent that a link comes from an arrow, never from a link tool", () => {
    const projected = projectComposerContextForProvider({
      text: "Run the suite on [vps](t3-context://v1/environment/env_vps)",
      records: [
        {
          version: 1,
          kind: "environment",
          contextId: "env_vps" as ComposerContextId,
          label: "vps",
          environmentId: "environment-vps" as never,
        },
      ],
    });
    expect(projected).toContain("links come from arrows on the machine map");
    expect(projected).not.toContain("t3_environment_link");
  });
});
