import { useAtomValue } from "@effect/atom-react";
import type { ClientSettings, KeybindingCommand, KeybindingShortcut } from "@t3tools/contracts";
import { Fragment, type ComponentProps, type ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import {
  ariaShortcut,
  effectiveShortcutsForCommand,
  formatShortcutLabel,
  type ShortcutMatchContext,
} from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { KEYBINDING_COMMAND_ATTRIBUTE } from "../../keybindingsMenu";
import { FOCUS_LEVELS_OFF } from "./focusLevels";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type ShortcutContext = Partial<ShortcutMatchContext>;

const selectTooltipShortcuts = (settings: ClientSettings) => settings.tooltipShortcuts;
const selectFocusLevels = (settings: ClientSettings) => settings.keyboardFocusLevels;

const selectShortcutLimit = (settings: ClientSettings) => settings.tooltipShortcutLimit;

/** One command, or the commands of a control that runs several, such as the composer model picker. */
type Commands = KeybindingCommand | ReadonlyArray<KeybindingCommand> | null;

/** A command of a control that runs several, with the name its tooltip shows before its keys. */
export interface NamedCommand {
  readonly command: KeybindingCommand;
  readonly name: string;
}

function commandList(commands: Commands): ReadonlyArray<KeybindingCommand> {
  if (commands === null) return [];
  return typeof commands === "string" ? [commands] : commands;
}

/**
 * Every key that runs each command where the tooltip shows. The last matching rule wins, so the
 * user's own rules, which come after the defaults, are listed first.
 */
function useShortcuts(
  commands: ReadonlyArray<KeybindingCommand>,
  context?: ShortcutContext,
): ReadonlyArray<ReadonlyArray<KeybindingShortcut>> {
  const levels = useClientSettings(selectFocusLevels);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // The level flags are always false while focus levels are off, so a key that needs one does nothing.
  const matchContext = levels ? (context ?? {}) : { ...context, ...FOCUS_LEVELS_OFF };
  return commands.map((command) =>
    effectiveShortcutsForCommand(keybindings, command, { context: matchContext }),
  );
}

/** The key labels of each command, in the order of `commands`. */
function useShortcutLabelLists(
  commands: ReadonlyArray<KeybindingCommand>,
  context?: ShortcutContext,
): ReadonlyArray<ReadonlyArray<string>> {
  const enabled = useClientSettings(selectTooltipShortcuts);
  const shortcutLists = useShortcuts(enabled ? commands : [], context);
  return commands.map((_, index) => [
    ...new Set((shortcutLists[index] ?? []).map((shortcut) => formatShortcutLabel(shortcut))),
  ]);
}

function useShortcutLabels(
  command: KeybindingCommand | null,
  context?: ShortcutContext,
): ReadonlyArray<string> {
  return useShortcutLabelLists(commandList(command), context)[0] ?? [];
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
  const props = useKeybindingProps(command ?? null);
  const labels = useShortcutLabels(command ?? null);
  if (command === undefined) return { hint: null, props };
  return {
    props,
    hint: !enabled ? null : labels.length > 0 ? (
      <ShortcutChips labels={labels} />
    ) : (
      <span aria-hidden className="ms-1.5 text-muted-foreground/40">
        –
      </span>
    ),
  };
}

/**
 * Fork: the props of an element that runs `command`: its `aria-keyshortcuts`, and the mark that
 * gives it the item menu ("Keybindings…") on right-click and Shift+F10. With several commands,
 * both list all of them.
 */
export function useKeybindingProps(command: Commands, context?: ShortcutContext) {
  const commands = commandList(command);
  const shortcuts = useShortcuts(commands, context).flat();
  if (commands.length === 0) return {};
  return {
    [KEYBINDING_COMMAND_ATTRIBUTE]: commands.join(" "),
    "aria-keyshortcuts":
      shortcuts.length > 0
        ? [...new Set(shortcuts.map((shortcut) => ariaShortcut(shortcut)))].join(" ")
        : undefined,
  };
}

/**
 * Fork: the trigger of a tooltip that names the key of `command` (`ShortcutHint` in its popup).
 * It gives the control `aria-keyshortcuts` and the item menu ("Keybindings…").
 */
export function ShortcutTrigger({
  command,
  context,
  ...props
}: ComponentProps<typeof TooltipTrigger> & {
  command: KeybindingCommand | null;
  context?: ShortcutContext;
}) {
  return <TooltipTrigger {...useKeybindingProps(command, context)} {...props} />;
}

/**
 * Fork: a tooltip trigger for a control without a tooltip. The tooltip shows `label` and the key
 * of `command`, and only when the command has a key. A control that runs several commands names
 * each one that has a key, on its own line. Use it as the trigger or as its `render`.
 */
export function ShortcutTooltip({
  command,
  context,
  label,
  side,
  ...triggerProps
}: ComponentProps<typeof TooltipTrigger> & {
  command: KeybindingCommand | ReadonlyArray<NamedCommand> | null;
  context?: ShortcutContext;
  label: ReactNode;
  side?: ComponentProps<typeof TooltipPopup>["side"];
}) {
  const single = command === null || typeof command === "string";
  const named = single ? null : command;
  const commands = single ? command : command.map((entry) => entry.command);
  const labelLists = useShortcutLabelLists(commandList(commands), context);
  const keybindingProps = useKeybindingProps(commands, context);
  const hasKeys = labelLists.some((labels) => labels.length > 0);
  return (
    <Tooltip disabled={!hasKeys}>
      <TooltipTrigger {...keybindingProps} {...triggerProps} />
      {hasKeys ? (
        <TooltipPopup side={side}>
          {label}
          {named ? (
            <span className="mt-1 grid grid-cols-[auto_auto] items-center gap-x-0.5 gap-y-1">
              {named.map((entry, index) => {
                const labels = labelLists[index] ?? [];
                return labels.length > 0 ? (
                  <Fragment key={entry.command}>
                    <span className="text-muted-foreground">{entry.name}</span>
                    <ShortcutChips labels={labels} />
                  </Fragment>
                ) : null;
              })}
            </span>
          ) : (
            <ShortcutChips labels={labelLists[0] ?? []} />
          )}
        </TooltipPopup>
      ) : null}
    </Tooltip>
  );
}
