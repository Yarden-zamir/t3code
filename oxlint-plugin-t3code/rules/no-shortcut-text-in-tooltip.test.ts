import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-shortcut-text-in-tooltip", {
  filename: "apps/web/src/components/Example.tsx",
});

describe("t3code/no-shortcut-text-in-tooltip", () => {
  rule.valid(
    "allows ShortcutHint inside a tooltip",
    `const tip = <TooltipPopup>Stash<ShortcutHint command="composer.stash" /></TooltipPopup>;`,
  );

  rule.valid(
    "allows a shortcut label in an aria-label",
    "const button = <Button aria-label={`Close (${closeShortcutLabel})`} />;",
  );

  rule.valid(
    "allows parentheses around other values",
    "const tip = <TooltipPopup>{`Split (max ${limit} per group)`}</TooltipPopup>;",
  );

  rule.invalid(
    "reports a conditional shortcut suffix in a tooltip popup",
    'const tip = <TooltipPopup>{label}{props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}</TooltipPopup>;',
  );

  rule.invalid(
    "reports a template title",
    "const button = <Button title={shortcutLabel ? `${action} (${shortcutLabel})` : action} />;",
  );

  rule.valid(
    "allows a shortcut label in the label of an element that is not a tooltip trigger",
    "const item = <MenuItem label={`Close (${closeShortcutLabel})`} />;",
  );

  rule.invalid(
    "reports a shortcut suffix in the label of a shared tooltip trigger",
    'const tip = <SharedTooltipTrigger render={button} label={<>{label}{shortcutLabel ? ` (${shortcutLabel})` : ""}</>} />;',
  );

  rule.invalid(
    "reports a concatenated tooltip prop",
    'const button = <PanelTabCloseButton tooltip={"Close (" + closeShortcutLabel + ")"} />;',
  );
});
