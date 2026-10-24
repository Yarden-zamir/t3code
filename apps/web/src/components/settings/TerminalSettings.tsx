import { Link } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { ForkSettingsSlot } from "./ForkSettingsSlot";
import { TerminalShellsSettings } from "./TerminalShellsSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * The terminal font stays in Appearance, where upstream keeps it, so that the fork does not move
 * an upstream row. This row only opens it there.
 */
function TerminalFontLinkRow() {
  return (
    <SettingsRow
      title="Terminal font"
      description="Set the terminal font in Appearance › Typography."
      control={
        <Button
          size="sm"
          variant="outline"
          render={
            <Link
              to="/settings/appearance"
              hash="terminal-font"
              hashScrollIntoView={false}
              state={{ settingsTargetHighlight: true }}
            />
          }
        >
          Open in Appearance
        </Button>
      }
    />
  );
}

/** Fork: Settings > Terminal, every setting of the drawer terminal and of terminal threads. */
export function TerminalSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="all-terminals" title="All terminals">
        <TerminalFontLinkRow />
        <ForkSettingsSlot place="terminal-all-terminals" />
      </SettingsSection>
      <SettingsSection id="terminal-thread-settings" title="Terminal threads">
        <ForkSettingsSlot place="terminal-threads" />
        <TerminalShellsSettings />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
