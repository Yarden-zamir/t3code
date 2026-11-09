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

  rule.invalid(
    "reports a concatenated tooltip prop",
    'const button = <PanelTabCloseButton tooltip={"Close (" + closeShortcutLabel + ")"} />;',
  );

  rule.invalid(
    "reports a label built in a variable first",
    "const closeLabel = `Close (${closeShortcutLabel})`;\nconst tip = <TooltipPopup>{closeLabel}</TooltipPopup>;",
  );

  rule.invalid(
    "reports two shortcut hints in one tooltip",
    `const tip = (
      <TooltipPopup>
        <span>New thread<ShortcutHint command="chat.new" /></span>
        <span>In current project<ShortcutHint command="chat.newLocal" /></span>
      </TooltipPopup>
    );`,
  );

  rule.invalid(
    "reports a click gesture described in tooltip text",
    `const tip = <TooltipPopup>New thread in current project: Shift+click</TooltipPopup>;`,
  );

  rule.valid(
    "allows tooltip rows for a second action",
    `const tip = (
      <TooltipPopup>
        New thread<ShortcutHint command="chat.new" />
        <TooltipRows rows={[{ command: "chat.newLocal", name: "In current project (Shift+click)" }]} />
      </TooltipPopup>
    );`,
  );

  rule.invalid(
    "reports a gesture inside a conditional template",
    "const tip = <TooltipPopup>{running ? `Click to ${mode}, Ctrl/⌘-click to ${other}` : label}</TooltipPopup>;",
  );

  rule.invalid(
    "reports a gesture written with spaces or a symbol",
    `const tip = <TooltipPopup>New thread: ⌘-click or Shift + click</TooltipPopup>;`,
  );

  rule.invalid(
    "reports two hints when one sits in a conditional",
    `const tip = (
      <TooltipPopup>
        New thread<ShortcutHint command="chat.new" />
        {more ? <span>Local<ShortcutHint command="chat.newLocal" /></span> : null}
      </TooltipPopup>
    );`,
  );

  rule.invalid(
    "reports a raw row in a hover card behind a condition",
    `const card = <ThreadHoverCard title="t">{branch ? <div>{branch}</div> : null}</ThreadHoverCard>;`,
  );

  rule.invalid(
    "reports a raw row in a hover card",
    `const card = <ThreadHoverCard title="t"><div className="flex">main</div></ThreadHoverCard>;`,
  );

  rule.valid(
    "allows typed rows in a hover card",
    `const card = <ThreadHoverCard title="t"><ThreadHoverCardRow action={null}>main</ThreadHoverCardRow></ThreadHoverCard>;`,
  );
});
