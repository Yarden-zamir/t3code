import { isElectron } from "../../env";
import { useMachineMapState } from "../../state/machineMap";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { ForkSettingsSlot } from "./ForkSettingsSlot";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

/** Fork: Settings > Machines: kitshn and the machine settings of the selected environment. */
export function MachinesSettingsPanel() {
  const { environment } = useSettingsScope();
  const { state } = useMachineMapState(environment?.environmentId ?? null);
  if (environment === null) return null;
  return (
    <SettingsPageContainer>
      {state?.hostNotWithKitshn === true ? (
        <Alert variant="warning">
          <AlertTitle>This machine's host is not with kitshn</AlertTitle>
          <AlertDescription>
            kitshn has no Access app for the T3 host of this machine yet. Run
            scripts/fork-host-handover.ts with the machine name to hand the host over.
          </AlertDescription>
        </Alert>
      ) : null}
      {/* Revisit when kitshn gives the desktop app device tokens (K-1617). */}
      {isElectron ? (
        <Alert variant="info">
          <AlertTitle>Machine list needs kitshn device tokens</AlertTitle>
          <AlertDescription>
            The desktop app does not add your other machines yet. Add a machine by hand in Settings
            &gt; Connections.
          </AlertDescription>
        </Alert>
      ) : null}
      <SettingsSection title="kitshn">
        <ForkSettingsSlot place="machines-machine-map" />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
