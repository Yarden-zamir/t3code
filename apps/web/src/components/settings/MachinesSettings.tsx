import { isElectron } from "../../env";
import { useMachineMapState } from "../../state/machineMap";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { ForkSettingsSlot } from "./ForkSettingsSlot";
import type { MachineMapClientState } from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
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
        {state === null ? null : <ConnectionRow connection={state.connection} />}
        <ForkSettingsSlot place="machines-machine-map" />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

const STATUS_TITLE = {
  off: "Not with kitshn",
  connecting: "Connecting to kitshn",
  registered: "Connected to kitshn",
} as const;

const LINK_PROXY_TEXT = {
  none: "no link proxy",
  unchecked: "link proxy not checked yet",
  checked: "link proxy checked",
} as const;

/** K-1611: the provider connection of this server and what kitshn gave it. */
function ConnectionRow({ connection }: { connection: MachineMapClientState["connection"] }) {
  const facts = [
    `${connection.grants} grants`,
    `${connection.reachedMachines} reached machines`,
    LINK_PROXY_TEXT[connection.linkProxy],
    connection.lastContactAt === null
      ? "no answer from kitshn yet"
      : `last answer from kitshn ${formatRelativeTimeLabel(new Date(connection.lastContactAt).toISOString())}`,
  ];
  return (
    <SettingsRow
      title={connection.paused ? "kitshn's emergency pause is on" : STATUS_TITLE[connection.status]}
      description={[connection.detail, facts.join(" · ")].filter(Boolean).join(". ")}
    />
  );
}
