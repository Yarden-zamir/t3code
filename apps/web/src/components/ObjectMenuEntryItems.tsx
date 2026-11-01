import { Fragment, type ComponentProps } from "react";

import { KEYBINDING_COMMAND_ATTRIBUTE } from "../keybindingsMenu";
import { objectMenuEntriesProps, type ObjectMenuEntry } from "../objectMenu";
import { MenuItem, MenuSeparator, MenuTrigger } from "./ui/menu";

/**
 * Fork: the trigger of an object's "…" menu. Entries may read refs when they run; as props of
 * this component they reach `objectMenuEntriesProps` without a React Compiler bailout.
 */
export function ObjectMenuTrigger({
  entries,
  ...props
}: ComponentProps<typeof MenuTrigger> & { entries: ReadonlyArray<ObjectMenuEntry | null> }) {
  return <MenuTrigger {...objectMenuEntriesProps(entries)} {...props} />;
}

/** Fork: the items of an object's "…" menu, from the entries its context menu also shows. */
export function ObjectMenuEntryItems({
  entries,
}: {
  entries: ReadonlyArray<ObjectMenuEntry | null>;
}) {
  return entries.map((entry) =>
    entry === null ? null : (
      <Fragment key={entry.label}>
        {entry.separatorBefore ? <MenuSeparator /> : null}
        <MenuItem
          disabled={entry.disabled}
          variant={entry.destructive ? "destructive" : "default"}
          {...(entry.keybindingCommand
            ? { [KEYBINDING_COMMAND_ATTRIBUTE]: entry.keybindingCommand }
            : {})}
          onClick={entry.run}
        >
          {entry.menuIcon}
          {entry.label}
        </MenuItem>
      </Fragment>
    ),
  );
}
