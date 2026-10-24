import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  MAX_TERMINAL_KEY_MAPPINGS,
  TerminalKeyMapping,
} from "@t3tools/contracts";
import {
  compileTerminalKeyMappings,
  ZLE_EDITOR_KEY_PRESET,
} from "@t3tools/shared/terminalKeyMappings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectMappings = (settings: ClientSettings) => settings.terminalKeyMappings;
const decodeMappings = Schema.decodeUnknownOption(
  Schema.Array(TerminalKeyMapping).check(Schema.isMaxLength(MAX_TERMINAL_KEY_MAPPINGS)),
);

function mergePreset(
  current: ReadonlyArray<TerminalKeyMapping>,
  preset: ReadonlyArray<TerminalKeyMapping>,
) {
  const keys = new Set(current.map((mapping) => mapping.key.toLowerCase()));
  return [...current, ...preset.filter((mapping) => !keys.has(mapping.key.toLowerCase()))];
}

/** Fork: `terminalKeyMappings`, keys that every terminal sends as fixed bytes. */
export function TerminalKeyMappingsSettingsRow() {
  const mappings = useClientSettings(selectMappings);
  const saved = JSON.stringify(mappings, null, 2);
  // The field keeps what the user typed until it saves, so a rejected entry stays visible.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (draft === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft.trim() === "" ? "[]" : draft);
    } catch {
      setError("This is not valid JSON.");
      return;
    }
    const decoded = decodeMappings(parsed);
    if (Option.isNone(decoded)) {
      setError(
        `Each entry needs "key" and "send". At most ${MAX_TERMINAL_KEY_MAPPINGS} entries; "send" up to 64 characters.`,
      );
      return;
    }
    const unusable = decoded.value.length - compileTerminalKeyMappings(decoded.value).length;
    if (unusable > 0) {
      setError(
        `${unusable} entr${unusable === 1 ? "y has" : "ies have"} a key or a send value that does not parse. Keys look like cmd+z. Escapes are \\e, \\xNN, \\uNNNN, \\r, \\n, \\t and \\\\.`,
      );
      return;
    }
    setError(null);
    setDraft(null);
    void updateClientSettings({ terminalKeyMappings: decoded.value });
  };

  const addPreset = (preset: ReadonlyArray<TerminalKeyMapping>) => {
    setError(null);
    setDraft(null);
    void updateClientSettings({ terminalKeyMappings: mergePreset(mappings, preset) });
  };

  return (
    <SettingsRow
      {...searchableSetting("terminal-key-mappings")}
      description='Keys that every terminal sends as fixed bytes, in place of its own encoding. Each entry has "key" (such as cmd+z), "send" (the bytes, with escapes such as \e). A mapped key replaces the encoding of the key, except copy while text is selected. App shortcuts, zoom and the built-in Cmd+arrow, Cmd+Backspace, Cmd+K and Ctrl+L keys act first.'
      status={error === null ? null : <span className="text-destructive-foreground">{error}</span>}
      resetAction={
        mappings.length > 0 ? (
          <SettingResetButton
            label="terminal key mappings"
            onClick={() => {
              setDraft(null);
              setError(null);
              void updateClientSettings({
                terminalKeyMappings: DEFAULT_CLIENT_SETTINGS.terminalKeyMappings,
              });
            }}
          />
        ) : null
      }
    >
      <div className="mt-3 flex flex-col gap-2">
        <Textarea
          value={draft ?? saved}
          aria-label="Terminal key mappings"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" onClick={() => addPreset(ZLE_EDITOR_KEY_PRESET)}>
            Add editor keys for zsh (macOS)
          </Button>
        </div>
      </div>
    </SettingsRow>
  );
}
