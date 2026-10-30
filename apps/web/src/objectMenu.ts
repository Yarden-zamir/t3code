import type { ContextMenuItem, KeybindingCommand } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { requestForkContextMenu } from "./forkContextMenu";
import { toastManager } from "./components/ui/toast";
import { writeTextToClipboard } from "./hooks/useCopyToClipboard";
import { bindableElement, selectionInside } from "./keybindingsMenu";

/**
 * Fork: an object that a user acts on, such as a message or a pin row, gets a context menu of its
 * own actions. The menu lists the buttons and links inside `data-object-menu-actions`, so it never
 * drifts from the visible controls, plus the copy entries of `objectMenuCopyProps`.
 */
export const OBJECT_MENU_ATTRIBUTE = "data-object-menu";
const OBJECT_MENU_ACTIONS_ATTRIBUTE = "data-object-menu-actions";
const COPY_ATTRIBUTE = "data-object-menu-copy";

type CopyEntry = { readonly label: string; readonly value: string };

export type ObjectMenuEntry = {
  readonly label: string;
  readonly run: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  /** An icon name of `ContextMenuItem.icon`, for the context menu. */
  readonly icon?: string;
  /** The icon of the item in a "…" menu (`ObjectMenuEntryItems`). */
  readonly menuIcon?: ReactNode;
  readonly separatorBefore?: boolean;
  readonly keybindingCommand?: KeybindingCommand;
};

const keepEntries = (entries: ReadonlyArray<ObjectMenuEntry | null>) =>
  entries.filter((entry): entry is ObjectMenuEntry => entry !== null);

function menuItemOf(entry: ObjectMenuEntry, id: string): ContextMenuItem {
  return {
    id,
    label: entry.label,
    ...(entry.disabled ? { disabled: true } : {}),
    ...(entry.destructive ? { destructive: true } : {}),
    ...(entry.separatorBefore ? { separatorBefore: true } : {}),
    ...(entry.icon === undefined ? {} : { icon: entry.icon }),
    ...(entry.keybindingCommand === undefined
      ? {}
      : { keybindingCommand: entry.keybindingCommand }),
  };
}

const MENU_ENTRIES_ATTRIBUTE = "data-object-menu-entries";
const menuEntries = new WeakMap<Element, readonly ObjectMenuEntry[]>();

/**
 * Props of the trigger of an object's "…" menu. The object menu shows the same entries, read
 * from here and not from the closed "…" menu.
 */
export function objectMenuEntriesProps(entries: ReadonlyArray<ObjectMenuEntry | null>) {
  const kept = keepEntries(entries);
  return {
    [MENU_ENTRIES_ATTRIBUTE]: "",
    ref: (element: Element | null) => {
      if (element !== null) menuEntries.set(element, kept);
    },
  };
}

/** Props of an object: its mark, and read actions that have no button, such as "Copy link". */
export function objectMenuProps(copy: ReadonlyArray<CopyEntry | null> = []) {
  const entries = copy.filter((entry): entry is CopyEntry => entry !== null && entry.value !== "");
  return {
    [OBJECT_MENU_ATTRIBUTE]: "",
    ...(entries.length > 0 ? { [COPY_ATTRIBUTE]: JSON.stringify(entries) } : {}),
  };
}

export const objectMenuActionsProps = { [OBJECT_MENU_ACTIONS_ATTRIBUTE]: "" };

// Text fields and menus keep their own menus.
const OWN_MENU_SELECTOR =
  'input, textarea, [contenteditable=""], [contenteditable="true"], [data-slot="menu-popup"]';

const LABEL_ATTRIBUTE = "data-object-menu-label";

/** A control whose accessible name is long content, such as a link, sets a short menu label. */
export const objectMenuLabelProps = (label: string) => ({ [LABEL_ATTRIBUTE]: label });

function actionLabel(control: HTMLElement): string {
  return (
    control.getAttribute(LABEL_ATTRIBUTE) ??
    control.getAttribute("aria-label") ??
    control.textContent ??
    ""
  ).trim();
}

function readCopyEntries(object: HTMLElement): ReadonlyArray<CopyEntry> {
  const raw = object.getAttribute(COPY_ATTRIBUTE);
  return raw === null ? [] : (JSON.parse(raw) as ReadonlyArray<CopyEntry>);
}

function objectControls(object: HTMLElement): HTMLElement[] {
  return [
    ...object.querySelectorAll<HTMLElement>(
      `[${OBJECT_MENU_ACTIONS_ATTRIBUTE}] button, [${OBJECT_MENU_ACTIONS_ATTRIBUTE}] a[href]`,
    ),
  ].filter(
    (control) =>
      // A nested object lists its own controls, and a popup trigger has no action of its own.
      control.closest(`[${OBJECT_MENU_ATTRIBUTE}]`) === object &&
      control.closest("[inert]") === null &&
      // A menu or list trigger opens choices, not one action; a popover trigger is one action.
      !["menu", "listbox", "true"].includes(control.getAttribute("aria-haspopup") ?? "") &&
      actionLabel(control) !== "",
  );
}

function onContextMenu(event: MouseEvent): void {
  if (event.defaultPrevented || !(event.target instanceof Element)) return;
  if (event.target.closest(OWN_MENU_SELECTOR)) return;
  // A link in content keeps its own menu: the app's link menu or the browser's. A link that is
  // one of the object's own actions, such as "Jump to message", belongs to the object menu.
  const link = event.target.closest("a[href]");
  if (link !== null && link.closest(`[${OBJECT_MENU_ACTIONS_ATTRIBUTE}]`) === null) return;
  const object = event.target.closest<HTMLElement>(`[${OBJECT_MENU_ATTRIBUTE}]`);
  if (object === null) return;
  // Selected text keeps the browser menu, with Copy.
  if (selectionInside(object)) return;
  const controls = objectControls(object);
  const extraEntries = [...object.querySelectorAll(`[${MENU_ENTRIES_ATTRIBUTE}]`)].flatMap(
    (trigger) =>
      trigger.closest(`[${OBJECT_MENU_ATTRIBUTE}]`) === object
        ? (menuEntries.get(trigger) ?? [])
        : [],
  );
  const copies = readCopyEntries(object);
  const items: ContextMenuItem[] = [
    ...controls.map((control, index) => {
      const command = bindableElement(control)?.commands[0];
      return {
        id: `control:${index}`,
        label: actionLabel(control),
        ...(control.matches(":disabled") || control.getAttribute("aria-disabled") === "true"
          ? { disabled: true }
          : {}),
        ...(command === undefined ? {} : { keybindingCommand: command }),
      };
    }),
    ...extraEntries.map((entry, index) => ({
      ...menuItemOf(entry, `entry:${index}`),
      ...(index === 0 && controls.length > 0 ? { separatorBefore: true } : {}),
    })),
    ...copies.map((entry, index) => ({
      id: `copy:${index}`,
      label: entry.label,
      icon: "copy",
      ...(index === 0 && controls.length + extraEntries.length > 0
        ? { separatorBefore: true }
        : {}),
    })),
  ];
  if (items.length === 0) return;
  const selected = requestForkContextMenu(items, { x: event.clientX, y: event.clientY });
  if (selected === undefined) return;
  event.preventDefault();
  void selected.then((id) => {
    if (id === null) return;
    const [kind, index] = id.split(":");
    if (kind === "control") controls[Number(index)]?.click();
    else if (kind === "entry") extraEntries[Number(index)]?.run();
    else {
      const entry = copies[Number(index)];
      if (entry) copyFromObjectMenu(entry.value, entry.label);
    }
  });
}

/** Listens in the bubble phase, so a control or link with its own menu goes first. */
let installed = false;

export function installObjectMenus(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("contextmenu", onContextMenu);
}

/**
 * Fork: the context menu of an indicator whose actions sit in a popover or a page, so no button
 * of it is in the DOM. Pass it as `onContextMenu`. Null entries drop out.
 */
export function showObjectMenu(
  event: {
    preventDefault: () => void;
    stopPropagation: () => void;
    currentTarget: EventTarget;
    clientX: number;
    clientY: number;
  },
  entries: ReadonlyArray<ObjectMenuEntry | null>,
): void {
  // Selected text keeps the browser menu, with Copy.
  if (selectionInside(event.currentTarget)) return;
  const kept = keepEntries(entries);
  const selected = requestForkContextMenu(
    kept.map((entry, index) => menuItemOf(entry, String(index))),
    { x: event.clientX, y: event.clientY },
  );
  if (selected === undefined) return;
  event.preventDefault();
  // A container menu, such as the thread details card, must not open as well.
  event.stopPropagation();
  void selected.then((id) => {
    if (id !== null) kept[Number(id)]?.run();
  });
}

/** Copies `value` for an object menu entry named `label`, and reports a failure. */
export function copyFromObjectMenu(value: string, label: string): void {
  writeTextToClipboard(value, label.toLowerCase()).catch((error: unknown) => {
    toastManager.add({
      type: "error",
      title: `Failed to ${label.toLowerCase()}`,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  });
}
