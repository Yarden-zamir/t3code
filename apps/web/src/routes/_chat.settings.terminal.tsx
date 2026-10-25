import { createFileRoute } from "@tanstack/react-router";

import { TerminalSettingsPanel } from "../components/settings/TerminalSettings";

export const Route = createFileRoute("/_chat/settings/terminal")({
  component: TerminalSettingsPanel,
});
