import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Fork: how this machine joins other machines: through kitshn, not in T3 (K-602). */
export function MachineMapSettingsRows() {
  return (
    <SettingsRow
      {...searchableSetting("machine-map")}
      description="This machine works with other machines through kitshn. Join it on the machine with kitshn join <code> --server <address>. The owner shares access between machines on the kitshn map."
    />
  );
}
