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
import {
  type ControlMenuEntry,
  controlMenuProps,
  KEYBINDING_COMMAND_ATTRIBUTE,
} from "../../keybindingsMenu";
import { useNavigate } from "@tanstack/react-router";
import { type SettingsSearchItemId, settingsSearchItem } from "../settings/settingsSearch";
import { FOCUS_LEVELS_OFF } from "./focusLevels";

const { composerFocus: _composerFocus, ...FORK_LEVELS_OFF } = FOCUS_LEVELS_OFF;
import { runKeybindingCommand } from "../../shortcuts/commandRunner";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type ShortcutContext = Partial<ShortcutMatchContext>;

const selectTooltipShortcuts = (settings: ClientSettings) => settings.tooltipShortcuts;
const selectFocusLevels = (settings: ClientSettings) => settings.keyboardFocusLevels;

const selectShortcutLimit = (settings: ClientSettings) => settings.tooltipShortcutLimit;

/** One command, or the commands of a control that runs several, such as the composer model picker. */
type Commands = KeybindingCommand | ReadonlyArray<KeybindingCommand> | null;

/**
 * Fork: a row of a tooltip. A row that names a command renders only as a button that runs it,
 * with its keys and the right-click "Keybindings…" menu. A text row carries no command and no
 * key, so an action cannot be written as plain text. `run` replaces the command runner when the
 * click must do more than the key does, such as a Shift+click variant.
 */
export type TooltipRow =
  | {
      readonly command: KeybindingCommand;
      readonly name: string;
      readonly context?: ShortcutContext;
      readonly run?: () => void;
      readonly text?: never;
    }
  | { readonly text: ReactNode; readonly command?: never };

/** A command row of `TooltipRow`. */
export type TooltipCommandRow = Extract<TooltipRow, { command: KeybindingCommand }>;

/**
 * Fork: what a tooltip shows: its label, the key of the trigger's own command, and rows for the
 * other actions it offers. Components take this instead of a free `ReactNode`, so a tooltip that
 * names a second action must give it as a row.
 */
export interface TooltipContent {
  readonly label: ReactNode;
  readonly rows?: ReadonlyArray<TooltipRow>;
  /** The control's right-click entries, shown before "Keybindings…". */
  readonly menu?: ReadonlyArray<TooltipMenuEntry>;
}

/**
 * Fork: an entry of a control's right-click menu. `settings` opens that setting in place;
 * the other form runs an action of the control that has no button of its own.
 */
export type TooltipMenuEntry =
  | { readonly settings: SettingsSearchItemId; readonly label?: never }
  | {
      readonly label: string;
      readonly run: () => void;
      readonly icon?: string;
      readonly settings?: never;
    };

/**
 * Fork: the props that give a control its right-click and Shift+F10 menu: its command rows as
 * entries that run them, and its `menu` entries. The keybindings item menu shows them before
 * "Keybindings…", in the same menu, so there is one menu per control.
 */
export function useControlMenuProps(content: {
  readonly rows?: TooltipContent["rows"] | undefined;
  readonly menu?: TooltipContent["menu"] | undefined;
}) {
  const navigate = useNavigate();
  const entries: ControlMenuEntry[] = [
    ...(content.rows ?? []).flatMap((row) =>
      row.command === undefined
        ? []
        : [
            {
              label: row.name,
              keybindingCommand: row.command,
              run: row.run ?? (() => runKeybindingCommand(row.command)),
            },
          ],
    ),
    ...(content.menu ?? []).map((entry) => {
      if (entry.settings === undefined) return entry;
      const item = settingsSearchItem(entry.settings);
      return {
        label: `Settings: ${item.title}`,
        icon: "settings",
        run: () =>
          void navigate({
            to: item.to,
            hash: item.targetId ?? item.id,
            hashScrollIntoView: false,
            state: { settingsTargetHighlight: true },
          }),
      };
    }),
  ];
  return controlMenuProps(entries);
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
  // The fork level flags are false while focus levels are off, so a key that needs one does
  // nothing. `composerFocus` stays: upstream sets it for its own send keys.
  const matchContext = levels ? (context ?? {}) : { ...context, ...FORK_LEVELS_OFF };
  return commands.map((command) =>
    effectiveShortcutsForCommand(keybindings, command, { context: matchContext }),
  );
}

/** The key labels of each row, each read in the row's own context, or `context` without one. */
function useRowShortcutLabels(
  rows: ReadonlyArray<TooltipCommandRow>,
  context?: ShortcutContext,
): ReadonlyArray<ReadonlyArray<string>> {
  const enabled = useClientSettings(selectTooltipShortcuts);
  const levels = useClientSettings(selectFocusLevels);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return rows.map((row) => {
    if (!enabled) return [];
    const rowContext = row.context ?? context;
    const matchContext = levels ? (rowContext ?? {}) : { ...rowContext, ...FORK_LEVELS_OFF };
    const shortcuts = effectiveShortcutsForCommand(keybindings, row.command, {
      context: matchContext,
    });
    return [...new Set(shortcuts.map((shortcut) => formatShortcutLabel(shortcut)))];
  });
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
  context?: ShortcutContext | undefined;
}) {
  const labels = useShortcutLabels(props.command, props.context);
  return labels.length > 0 ? <ShortcutChips labels={labels} /> : null;
}

/** Fork: a fixed key without a keybinding command, such as Esc, as a chip after tooltip text. */
export function KeyHint(props: { label: string }) {
  const enabled = useClientSettings(selectTooltipShortcuts);
  return enabled ? <ShortcutChips labels={[props.label]} /> : null;
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
  rows,
  menu,
  ...props
}: ComponentProps<typeof TooltipTrigger> & {
  command: KeybindingCommand | null;
  context?: ShortcutContext;
  /** The tooltip's rows and menu; they become the control's right-click entries. */
  rows?: TooltipContent["rows"] | undefined;
  menu?: TooltipContent["menu"] | undefined;
}) {
  return (
    <TooltipTrigger
      {...useKeybindingProps(command, context)}
      {...useControlMenuProps({ rows, menu })}
      {...props}
    />
  );
}

/**
 * Fork: a command named in a tooltip, as a button that runs it. Right-click opens its
 * "Keybindings…" menu, as on any element that runs a command.
 */
function CommandRow({
  command,
  labels,
  run,
  children,
}: {
  command: KeybindingCommand;
  labels: ReadonlyArray<string>;
  run: (() => void) | undefined;
  children: ReactNode;
}) {
  const keybindingProps = useKeybindingProps(command);
  return (
    <Button
      size="xs-multiline"
      variant="ghost"
      className="-mx-1 justify-between"
      {...keybindingProps}
      onClick={() => (run ? run() : runKeybindingCommand(command))}
    >
      <span className="min-w-0 text-left text-muted-foreground">{children}</span>
      <span className="shrink-0">
        <ShortcutChips labels={labels} />
      </span>
    </Button>
  );
}

/**
 * Fork: the rows of a tooltip under its label. A command row shows only while its command has a
 * key in `context` (or in its own context), so a row never claims a key that does not work.
 * A row with `run` shows always, because its click does something a key cannot.
 */
export function TooltipRows({
  rows,
  context,
}: {
  rows: ReadonlyArray<TooltipRow>;
  context?: ShortcutContext | undefined;
}) {
  const commandRows = rows.filter((row): row is TooltipCommandRow => row.command !== undefined);
  const labelLists = useRowShortcutLabels(commandRows, context);
  const shown = rows.filter((row) => {
    if (row.command === undefined) return true;
    const index = commandRows.indexOf(row);
    return row.run !== undefined || (labelLists[index]?.length ?? 0) > 0;
  });
  if (shown.length === 0) return null;
  return (
    <span className="mt-1 flex flex-col items-stretch gap-0.5">
      {shown.map((row, index) =>
        row.command === undefined ? (
          // oxlint-disable-next-line react/no-array-index-key -- the rows of one tooltip are a fixed list
          <span key={index} className="text-muted-foreground">
            {row.text}
          </span>
        ) : (
          <CommandRow
            key={row.command}
            command={row.command}
            labels={labelLists[commandRows.indexOf(row)] ?? []}
            run={row.run}
          >
            {row.name}
          </CommandRow>
        ),
      )}
    </span>
  );
}

/** Fork: a tooltip body from `TooltipContent`: the label, the trigger command's key, the rows. */
export function TooltipBody({
  content,
  command = null,
  context,
}: {
  content: TooltipContent;
  /** The trigger's own command, whose key shows after the label. */
  command?: KeybindingCommand | null;
  context?: ShortcutContext | undefined;
}) {
  return (
    <>
      {content.label}
      <ShortcutHint command={command} context={context} />
      {content.rows ? <TooltipRows rows={content.rows} context={context} /> : null}
    </>
  );
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
  menu,
  ...triggerProps
}: ComponentProps<typeof TooltipTrigger> & {
  command: KeybindingCommand | ReadonlyArray<TooltipCommandRow> | null;
  context?: ShortcutContext;
  label: ReactNode;
  side?: ComponentProps<typeof TooltipPopup>["side"];
  menu?: TooltipContent["menu"] | undefined;
}) {
  const single = command === null || typeof command === "string";
  const rows = single ? null : command;
  const commands = single ? command : command.map((entry) => entry.command);
  const labelLists = useShortcutLabelLists(commandList(commands), context);
  const keybindingProps = useKeybindingProps(commands, context);
  const controlMenu = useControlMenuProps({ rows: rows ?? [], menu });
  const hasKeys = labelLists.some((labels) => labels.length > 0);
  return (
    <Tooltip disabled={!hasKeys}>
      <TooltipTrigger {...keybindingProps} {...controlMenu} {...triggerProps} />
      {hasKeys ? (
        <TooltipPopup side={side}>
          {label}
          {rows ? (
            <TooltipRows rows={rows} context={context} />
          ) : (
            <ShortcutChips labels={labelLists[0] ?? []} />
          )}
        </TooltipPopup>
      ) : null}
    </Tooltip>
  );
}
