import { type ClientAccessMode, type MachineLevel } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { useMachineMapState } from "../../state/machineMap";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ForkSettingsSlot } from "./ForkSettingsSlot";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/**
 * Fork: Settings > Machines (apps/machine-map/SPEC.md MM-203, MM-1004). The state of the machine
 * map on the selected environment: join with a code, leave, and the machines it can use.
 */

const LEVEL_BADGES: Record<
  MachineLevel,
  { readonly label: string; readonly variant: "outline" | "info" | "secondary" | "warning" }
> = {
  none: { label: "None", variant: "outline" },
  read: { label: "Read", variant: "secondary" },
  standard: { label: "Standard", variant: "info" },
  admin: { label: "Admin", variant: "warning" },
};

export function MachinesSettingsPanel() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const { state } = useMachineMapState(environmentId);
  if (environmentId === null) return null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Machine map">
        <ForkSettingsSlot place="machines-machine-map" />
        {state?.joined ? <ClientAccessSettingsRow /> : null}
      </SettingsSection>

      {state?.joined ? (
        <SettingsSection {...searchableSetting("machine-map-reachable")}>
          {state.reachable.length === 0 ? (
            <SettingsRow
              title="No machines"
              description="Give this machine an arrow to another machine in the portal."
            />
          ) : (
            state.reachable.map((peer) => {
              const level = LEVEL_BADGES[peer.level];
              return (
                <SettingsRow
                  key={peer.machine.id}
                  title={peer.machine.name}
                  description={peer.agentTools ? `${peer.origin}, with agent tools` : peer.origin}
                  control={
                    <div className="flex items-center gap-2">
                      <Badge variant={level.variant}>{level.label}</Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        render={<a href={peer.origin} target="_blank" rel="noreferrer" />}
                      >
                        Open
                      </Button>
                    </div>
                  }
                />
              );
            })
          )}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

const CLIENT_ACCESS_LABELS: Record<ClientAccessMode, string> = {
  off: "Off",
  observe: "Observe",
  enforce: "Enforce",
};

/**
 * MM-919: the way back in when `enforce` locks every browser out. The portal sets `clientAccess`
 * on the approval path; on a machine, only its own desktop app may change it, and the portal then
 * sends a push message.
 */
function ClientAccessSettingsRow() {
  const mode = useScopedSettings((settings) => settings.clientAccess);
  const updateSettings = useUpdateScopedSettings();
  const { environment } = useSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Only the desktop app of the selected machine itself may change it; a remote one refuses.
  const local = isElectron && environment?.environmentId === primaryEnvironmentId;
  return (
    <SettingsRow
      {...searchableSetting("machine-map-client-access")}
      serverScoped
      settingKeys={["clientAccess"]}
      description="Which browsers get in through Cloudflare Access. Set it in the portal. Only the desktop app of this machine changes it here, as the way back in."
      control={
        <Select
          value={mode}
          disabled={!local}
          onValueChange={(value) => {
            if (value !== "off" && value !== "observe" && value !== "enforce") return;
            updateSettings({ clientAccess: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Client access">
            <SelectValue>{CLIENT_ACCESS_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(CLIENT_ACCESS_LABELS).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
