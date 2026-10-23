import { Schema } from "effect";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  TerminalAppShortcutsFirstSettingsRow,
  TerminalCloseConfirmationSettingsRow,
} from "./ForkSettingsRows";
import { TerminalFontPreview } from "./SettingsFontPreviews";
import { TerminalFontRow } from "./SettingsPanels";
import { TerminalHistorySettingsRows } from "./TerminalHistorySettingsRows";
import { TerminalKeyMappingsSettingsRow } from "./TerminalKeyMappingsSettingsRow";
import { TerminalShellsSettings } from "./TerminalShellsSettings";
import { TerminalThreadFontLimitsSettingsRow } from "./TerminalThreadFontLimitsSettingsRow";
import { TerminalThreadsSettingsRow } from "./TerminalThreadsSettingsRow";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Fork: the terminal font applies only with advanced typography. Without it, every terminal uses
 * the monospace font of Appearance, so the row says that instead of editing a font that no
 * terminal shows.
 */
function TerminalFontSettingsRow() {
  const [advanced, setAdvanced] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const monospace = useClientSettings((settings) => ({
    family: settings.fontFamilyCode,
    size: settings.fontSizeCode,
  }));
  if (advanced) return <TerminalFontRow />;
  return (
    <SettingsRow
      {...searchableSetting("terminal-font")}
      description="Terminals use the monospace font of Appearance. A separate font turns on advanced typography."
      control={
        <Button size="sm" variant="outline" onClick={() => setAdvanced(true)}>
          Use a separate font
        </Button>
      }
    >
      <TerminalFontPreview family={monospace.family} size={monospace.size} />
    </SettingsRow>
  );
}

/** Fork: Settings > Terminal, every setting of the drawer terminal and of terminal threads. */
export function TerminalSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="all-terminals" title="All terminals">
        <TerminalFontSettingsRow />
        <TerminalThreadFontLimitsSettingsRow />
        <TerminalKeyMappingsSettingsRow />
        <TerminalAppShortcutsFirstSettingsRow />
        <TerminalCloseConfirmationSettingsRow />
        <TerminalHistorySettingsRows />
      </SettingsSection>
      <SettingsSection id="terminal-thread-settings" title="Terminal threads">
        <TerminalThreadsSettingsRow />
        <TerminalShellsSettings />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
