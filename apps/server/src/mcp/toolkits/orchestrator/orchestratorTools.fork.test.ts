import { expect, it } from "@effect/vitest";
import { McpSchema } from "effect/ai";
import * as Context from "effect/Context";

import { OrchestratorToolkit } from "./tools.ts";

const client = { protocolVersion: "2025-06-18", capabilities: {} };
const enabled = (name: keyof typeof OrchestratorToolkit.tools) =>
  Context.getOrUndefined(
    OrchestratorToolkit.tools[name].annotations,
    McpSchema.EnabledWhen,
  )?.(client);

it("hides the manual link tools and keeps the arrow links listed", () => {
  expect(enabled("t3_environment_link")).toBe(false);
  expect(enabled("t3_environment_unlink")).toBe(false);
  // Without an invocation context the links tool shows, as with links on.
  expect(enabled("t3_environment_links")).toBe(true);
  expect(OrchestratorToolkit.tools.t3_environment_links.description).toContain(
    "arrows on the machine map",
  );
});
