import { describe, expect, it } from "vite-plus/test";

import {
  compileTerminalKeyMappings,
  decodeTerminalKeySequence,
  ZLE_EDITOR_KEY_PRESET,
} from "./terminalKeyMappings.ts";

describe("decodeTerminalKeySequence", () => {
  it("decodes the escapes of the key mapping notation", () => {
    expect(decodeTerminalKeySequence("\\e[122;9u")).toBe("\u001b[122;9u");
    expect(decodeTerminalKeySequence("\\x1b\\u0041\\r\\n\\t\\\\")).toBe("\u001bA\r\n\t\\");
  });

  it("rejects a sequence that would send half a key", () => {
    expect(decodeTerminalKeySequence("abc\\")).toBeNull();
    expect(decodeTerminalKeySequence("\\x1")).toBeNull();
    expect(decodeTerminalKeySequence("\\q")).toBeNull();
    expect(decodeTerminalKeySequence("")).toBeNull();
  });
});

describe("compileTerminalKeyMappings", () => {
  it("keeps every entry of the editor preset", () => {
    expect(compileTerminalKeyMappings(ZLE_EDITOR_KEY_PRESET)).toHaveLength(
      ZLE_EDITOR_KEY_PRESET.length,
    );
  });

  it("drops an entry with a key or sequence that does not parse", () => {
    expect(
      compileTerminalKeyMappings([
        { key: "cmd+z", send: "\\e[122;9u", passthrough: true },
        { key: "cmd++z+", send: "x", passthrough: false },
        { key: "cmd+y", send: "\\q", passthrough: false },
      ]).map((mapping) => mapping.data),
    ).toEqual(["\u001b[122;9u"]);
  });
});
