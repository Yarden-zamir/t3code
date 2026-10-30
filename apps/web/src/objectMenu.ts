import type { ContextMenuItem, KeybindingCommand } from "@t3tools/contracts";

import { requestForkContextMenu } from "./forkContextMenu";
import { writeTextToClipboard } from "./hooks/useCopyToClipboard";
import { bindableElement } from "./keybindingsMenu";

/**
 * Fork: an object that a user acts on, such as a message or a pin row, gets a context menu of its
 * own actions. The menu lists the buttons and links inside `data-object-menu-actions`, so it never
 * drifts from the visible controls, plus the copy entries of `objectMenuCopyProps`.
 */
export const OBJECT_MENU_ATTRIBUTE = "data-object-menu";
const OBJECT_MENU_ACTIONS_ATTRIBUTE = "data-object-menu-actions";
const COPY_ATTRIBUTE = "data-object-menu-copy";

type CopyEntry = { readonly label: string; readonly value: string };

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
  const object = event.target.closest<HTMLElement>(`[${OBJECT_MENU_ATTRIBUTE}]`);
  if (object === null) return;
  // Selected text keeps the browser menu, with Copy.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && object.contains(selection.anchorNode)) return;
  const controls = objectControls(object);
  const copies = readCopyEntries(object);
  const items: ContextMenuItem[] = [
    ...controls.map((control, index) => {
      const command = bindableElement(control)?.command;
      return {
        id: `control:${index}`,
        label: actionLabel(control),
        ...(control.matches(":disabled") || control.getAttribute("aria-disabled") === "true"
          ? { disabled: true }
          : {}),
        ...(command === undefined ? {} : { keybindingCommand: command }),
      };
    }),
    ...copies.map((entry, index) => ({
      id: `copy:${index}`,
      label: entry.label,
      icon: "copy",
      ...(index === 0 && controls.length > 0 ? { separatorBefore: true } : {}),
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
    else {
      const entry = copies[Number(index)];
      if (entry) void writeTextToClipboard(entry.value, entry.label.toLowerCase());
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

export type ObjectMenuEntry = {
  readonly label: string;
  readonly run: () => void;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly keybindingCommand?: KeybindingCommand;
};

/**
 * Fork: the context menu of an indicator whose actions sit in a popover or a page, so no button
 * of it is in the DOM. Pass it as `onContextMenu`. Null entries drop out.
 */
export function showObjectMenu(
  event: {
    preventDefault: () => void;
    stopPropagation: () => void;
    clientX: number;
    clientY: number;
  },
  entries: ReadonlyArray<ObjectMenuEntry | null>,
): void {
  const kept = entries.filter((entry): entry is ObjectMenuEntry => entry !== null);
  const selected = requestForkContextMenu(
    kept.map((entry, index) => ({
      id: String(index),
      label: entry.label,
      ...(entry.disabled ? { disabled: true } : {}),
      ...(entry.icon === undefined ? {} : { icon: entry.icon }),
      ...(entry.keybindingCommand === undefined
        ? {}
        : { keybindingCommand: entry.keybindingCommand }),
    })),
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

/** Copies `value` as an object menu action. */
export function copyFromObjectMenu(value: string, target: string): void {
  void writeTextToClipboard(value, target);
}
