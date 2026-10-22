import { describe, expect, it } from "vite-plus/test";

import { buildT3ProjectFileJsonSchema } from "./t3ProjectFile.ts";

describe("fork t3.json schema", () => {
  // Fork: a project script can run in the background (Global scripts).
  it("documents runInBackground on scripts", () => {
    const schema = buildT3ProjectFileJsonSchema() as {
      properties: { scripts?: { items?: { properties: Record<string, unknown> } } };
    };
    expect(schema.properties.scripts?.items?.properties).toHaveProperty("runInBackground");
  });
});
