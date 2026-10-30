import type { ReactElement } from "react";

import { Menu } from "./ui/Menu";

/** One action of an object's long-press menu. */
export type LongPressMenuEntry = {
  readonly id: string;
  readonly title: string;
  readonly run: () => void;
  /** An SF Symbol name, as the other app menus use. */
  readonly image?: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
};

/**
 * Fork: the long-press menu of an object, such as a message or a pin row, the mobile side of the
 * web context menus (`apps/web/src/objectMenu.ts`). Null entries drop out; with none, the child
 * renders alone.
 */
export function LongPressMenu(props: {
  readonly entries: ReadonlyArray<LongPressMenuEntry | null>;
  readonly children: ReactElement;
}) {
  const entries = props.entries.filter((entry): entry is LongPressMenuEntry => entry !== null);
  if (entries.length === 0) return props.children;
  return (
    <Menu
      shouldOpenOnLongPress
      actions={entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        ...(entry.image === undefined ? {} : { image: entry.image }),
        attributes: {
          ...(entry.destructive ? { destructive: true } : {}),
          ...(entry.disabled ? { disabled: true } : {}),
        },
      }))}
      onPressAction={({ nativeEvent }) => {
        entries.find((entry) => entry.id === nativeEvent.event)?.run();
      }}
    >
      {props.children}
    </Menu>
  );
}
