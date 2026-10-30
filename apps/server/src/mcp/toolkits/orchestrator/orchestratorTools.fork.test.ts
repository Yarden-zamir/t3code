import { expect, it } from "@effect/vitest";
import { McpSchema } from "effect/ai";
import * as Context from "effect/Context";

import { McpToolkits } from "../registry.ts";
import { OrchestratorToolkit } from "./tools.ts";

const client = { protocolVersion: "2025-06-18", capabilities: {} };
const enabled = (name: keyof typeof OrchestratorToolkit.tools) =>
  Context.getOrUndefined(
    McpToolkits.orchestrator.tools[name].annotations,
    McpSchema.EnabledWhen,
  )?.(client);

it("hides the manual link tools that /mcp publishes, also with links on", () => {
  // Without an invocation context, upstream's gate reads as links on.
  expect(enabled("t3_environment_links")).toBe(true);
  expect(enabled("t3_environment_link")).toBe(false);
  expect(enabled("t3_environment_unlink")).toBe(false);
  // Upstream's toolkit keeps its own gate, which upstream's tests check.
  expect(
    Context.getOrUndefined(
      OrchestratorToolkit.tools.t3_environment_link.annotations,
      McpSchema.EnabledWhen,
    )?.(client),
  ).toBe(true);
  expect(McpToolkits.orchestrator.tools.t3_environment_links.description).toContain(
    "links come from kitshn",
  );
});
