import { ForkSettingsSlot } from "./ForkSettingsSlot";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

/** Fork: Settings > Machines: kitshn and the machine settings of the selected environment. */
export function MachinesSettingsPanel() {
  const { environment } = useSettingsScope();
  if (environment === null) return null;
  return (
    <SettingsPageContainer>
      <SettingsSection title="kitshn">
        <ForkSettingsSlot place="machines-machine-map" />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
