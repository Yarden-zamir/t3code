import { createFileRoute } from "@tanstack/react-router";

import { MachinesSettingsPanel } from "../components/settings/MachinesSettings";

export const Route = createFileRoute("/_chat/settings/machines")({ component: MachinesSettingsPanel });
