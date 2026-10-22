import {
  TERMINAL_THREAD_FIND_SEQUENCE,
  type KeybindingShortcut,
  type TerminalKeyMapping,
} from "@t3tools/contracts";

import { matchesKeybindingShortcut, parseKeybindingShortcut } from "./keybindings.ts";

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  e: "\u001b",
  r: "\r",
  n: "\n",
  t: "\t",
  "\\": "\\",
};

function readHex(text: string, start: number, length: number): string | null {
  const digits = text.slice(start, start + length);
  if (digits.length !== length) return null;
  for (const digit of digits) if (!"0123456789abcdefABCDEF".includes(digit)) return null;
  return String.fromCharCode(Number.parseInt(digits, 16));
}

/**
 * Turns escape notation into the bytes to send: `\e`, `\xNN`, `\uNNNN`, `\r`, `\n`, `\t` and
 * `\\`. Returns null for a trailing or unknown escape, so a mistake never sends half a sequence.
 */
export function decodeTerminalKeySequence(text: string): string | null {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "\\") {
      out += character;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) return null;
    const simple = SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      out += simple;
      index += 1;
      continue;
    }
    const hexLength = next === "x" ? 2 : next === "u" ? 4 : 0;
    const decoded = hexLength === 0 ? null : readHex(text, index + 2, hexLength);
    if (decoded === null) return null;
    out += decoded;
    index += 1 + hexLength;
  }
  return out.length === 0 ? null : out;
}

export interface CompiledTerminalKeyMapping {
  readonly shortcut: KeybindingShortcut;
  readonly data: string;
  readonly passthrough: boolean;
}

/** Drops a mapping with a key or sequence that does not parse. */
export function compileTerminalKeyMappings(
  mappings: ReadonlyArray<TerminalKeyMapping>,
): ReadonlyArray<CompiledTerminalKeyMapping> {
  return mappings.flatMap((mapping) => {
    const shortcut = parseKeybindingShortcut(mapping.key);
    const data = decodeTerminalKeySequence(mapping.send);
    return shortcut === null || data === null
      ? []
      : [{ shortcut, data, passthrough: mapping.passthrough }];
  });
}

export function findTerminalKeyMapping(
  compiled: ReadonlyArray<CompiledTerminalKeyMapping>,
  event: Parameters<typeof matchesKeybindingShortcut>[0],
  platform: string,
): CompiledTerminalKeyMapping | null {
  return (
    compiled.find((mapping) => matchesKeybindingShortcut(event, mapping.shortcut, platform)) ?? null
  );
}

/**
 * The Command keys of an editor-like ZLE setup (select all, copy, cut, undo, redo and the line
 * and buffer jumps), as the Kitty keyboard protocol writes them. `passthrough` keeps a
 * multiplexer from reading them as Meta keys.
 */
export const ZLE_EDITOR_KEY_PRESET: ReadonlyArray<TerminalKeyMapping> = [
  { key: "cmd+a", send: "\\e[97;9u", passthrough: true },
  { key: "cmd+c", send: "\\e[99;9u", passthrough: true },
  { key: "cmd+x", send: "\\e[120;9u", passthrough: true },
  { key: "cmd+z", send: "\\e[122;9u", passthrough: true },
  { key: "cmd+shift+z", send: "\\e[122;10u", passthrough: true },
  { key: "cmd+arrowup", send: "\\e[1;9A", passthrough: true },
  { key: "cmd+arrowdown", send: "\\e[1;9B", passthrough: true },
  { key: "cmd+shift+arrowup", send: "\\e[1;10A", passthrough: true },
  { key: "cmd+shift+arrowdown", send: "\\e[1;10B", passthrough: true },
];

/**
 * `cmd+f` on macOS and `ctrl+shift+f` elsewhere open tmux search (no passthrough: tmux reads it).
 * Limit: a mapping applies in every terminal, so these keys send junk to a terminal without tmux.
 * Revisit when a mapping needs a scope.
 */
export const TMUX_KEY_PRESET: ReadonlyArray<TerminalKeyMapping> = [
  { key: "cmd+f", send: encodeForMapping(TERMINAL_THREAD_FIND_SEQUENCE), passthrough: false },
  {
    key: "ctrl+shift+f",
    send: encodeForMapping(TERMINAL_THREAD_FIND_SEQUENCE),
    passthrough: false,
  },
];

function encodeForMapping(sequence: string): string {
  return sequence.replaceAll("\u001b", "\\e");
}
