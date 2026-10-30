import { createFileRoute } from "@tanstack/react-router";

import { KeybindingsSettingsPanel } from "../components/settings/KeybindingsSettings";
import { validateKeybindingsSearch } from "../components/settings/KeybindingsSettings.logic";

export const Route = createFileRoute("/_chat/settings/keybindings")({
  validateSearch: validateKeybindingsSearch,
  component: KeybindingsSettingsPanel,
});
