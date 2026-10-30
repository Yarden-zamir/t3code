import type { KeybindingShortcut } from "@t3tools/contracts";

// Keybindings store lowercase keys such as "arrowdown"; recorded snapshot keys keep event names.
const ELECTRON_KEY_NAMES: Readonly<Record<string, string>> = {
  " ": "Space",
  "+": "Plus",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Escape: "Esc",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  arrowup: "Up",
  escape: "Esc",
};

export function toElectronAccelerator(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("CommandOrControl");
  if (shortcut.metaKey) parts.push("Super");
  if (shortcut.ctrlKey) parts.push("Control");
  if (shortcut.altKey) parts.push("Alt");
  if (shortcut.shiftKey) parts.push("Shift");
  parts.push(ELECTRON_KEY_NAMES[shortcut.key] ?? shortcut.key.toUpperCase());
  return parts.join("+");
}
