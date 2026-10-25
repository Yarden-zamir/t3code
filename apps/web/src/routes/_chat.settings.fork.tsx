import { createFileRoute } from "@tanstack/react-router";

import { ForkSettingsPanel } from "../components/settings/ForkSettings";

export const Route = createFileRoute("/_chat/settings/fork")({ component: ForkSettingsPanel });
