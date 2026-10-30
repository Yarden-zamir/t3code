import { useAtomValue } from "@effect/atom-react";
import type { ClientSettings, KeybindingCommand, KeybindingShortcut } from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import {
  ariaShortcut,
  effectiveShortcutsForCommand,
  formatShortcutLabel,
  type ShortcutMatchContext,
} from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { FOCUS_LEVELS_OFF } from "./focusLevels";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type ShortcutContext = Partial<ShortcutMatchContext>;

const selectTooltipShortcuts = (settings: ClientSettings) => settings.tooltipShortcuts;
const selectFocusLevels = (settings: ClientSettings) => settings.keyboardFocusLevels;

const selectShortcutLimit = (settings: ClientSettings) => settings.tooltipShortcutLimit;

/**
 * Every key that runs `command` where the tooltip shows. The last matching rule wins, so the
 * user's own rules, which come after the defaults, are listed first.
 */
function useShortcuts(
  command: KeybindingCommand | null,
  context?: ShortcutContext,
): ReadonlyArray<KeybindingShortcut> {
  const levels = useClientSettings(selectFocusLevels);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  if (command === null) return [];
  // The level flags are always false while focus levels are off, so a key that needs one does nothing.
  return effectiveShortcutsForCommand(keybindings, command, {
    context: levels ? (context ?? {}) : { ...context, ...FOCUS_LEVELS_OFF },
  });
}

function useShortcutLabels(
  command: KeybindingCommand | null,
  context?: ShortcutContext,
): ReadonlyArray<string> {
  const enabled = useClientSettings(selectTooltipShortcuts);
  const shortcuts = useShortcuts(enabled ? command : null, context);
  return [...new Set(shortcuts.map((shortcut) => formatShortcutLabel(shortcut)))];
}

/** Keys beyond the `tooltipShortcutLimit` setting show as "+N"; Settings → Keybindings lists them all. */
function ShortcutChips({ labels }: { labels: ReadonlyArray<string> }) {
  const limit = useClientSettings(selectShortcutLimit);
  const hidden = labels.length - limit;
  return (
    <span className="ms-1.5 inline-flex items-center gap-1 align-middle">
      {labels.slice(0, limit).map((label) => (
        <Kbd key={label}>{label}</Kbd>
      ))}
      {hidden > 0 ? <span className="text-muted-foreground">+{hidden}</span> : null}
    </span>
  );
}

/**
 * Fork: the keys of `command` as chips after the text of an existing tooltip. A tooltip popup
 * mounts only while open, so many rows cost no subscription until one shows its tooltip.
 */
export function ShortcutHint(props: {
  command: KeybindingCommand | null;
  context?: ShortcutContext;
}) {
  const labels = useShortcutLabels(props.command, props.context);
  return labels.length > 0 ? <ShortcutChips labels={labels} /> : null;
}

/**
 * Fork: the keys of a menu item, as chips and as its `aria-keyshortcuts`. An item without a key
 * shows a faint dash, a sign that its item menu can bind one.
 */
export function useMenuItemShortcut(command: KeybindingCommand | undefined) {
  const enabled = useClientSettings(selectTooltipShortcuts);
  const shortcuts = useShortcuts(command ?? null);
  const labels = useShortcutLabels(command ?? null);
  if (command === undefined) return { hint: null, ariaKeyShortcuts: undefined };
  return {
    hint: !enabled ? null : labels.length > 0 ? (
      <ShortcutChips labels={labels} />
    ) : (
      <span aria-hidden className="ms-1.5 text-muted-foreground/40">
        –
      </span>
    ),
    ariaKeyShortcuts:
      shortcuts.length > 0
        ? shortcuts.map((shortcut) => ariaShortcut(shortcut)).join(" ")
        : undefined,
  };
}

/**
 * Fork: a tooltip trigger for a control without a tooltip. The tooltip shows `label` and the key
 * of `command`, and only when the command has a key. Use it as the trigger or as its `render`.
 */
export function ShortcutTooltip({
  command,
  context,
  label,
  side,
  ...triggerProps
}: ComponentProps<typeof TooltipTrigger> & {
  command: KeybindingCommand | null;
  context?: ShortcutContext;
  label: ReactNode;
  side?: ComponentProps<typeof TooltipPopup>["side"];
}) {
  const labels = useShortcutLabels(command, context);
  return (
    <Tooltip disabled={labels.length === 0}>
      <TooltipTrigger {...triggerProps} />
      {labels.length > 0 ? (
        <TooltipPopup side={side}>
          {label}
          <ShortcutChips labels={labels} />
        </TooltipPopup>
      ) : null}
    </Tooltip>
  );
}
