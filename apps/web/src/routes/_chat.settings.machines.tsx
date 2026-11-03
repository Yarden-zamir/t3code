import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { FleetSettingsPanel, type FleetTab } from "../components/settings/MachinesSettings";

function FleetRoute() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <FleetSettingsPanel
      tab={tab ?? "machines"}
      onTabChange={(next) =>
        void navigate({
          search: ({ tab: _previousTab, ...previous }) =>
            next === "machines" ? previous : { ...previous, tab: next },
          replace: true,
        })
      }
    />
  );
}

export const Route = createFileRoute("/_chat/settings/machines")({
  validateSearch: (raw: Record<string, unknown>): { tab?: FleetTab } =>
    raw.tab === "changelog" ? { tab: "changelog" } : {},
  component: FleetRoute,
});
