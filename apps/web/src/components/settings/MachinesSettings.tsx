import { isElectron } from "../../env";
import { DeviceInviteSettingsRow } from "../../machineMap/desktopDevice";
import { useClientSettings } from "../../hooks/useSettings";
import { useKitshnMachines, usePrimaryEnvironmentId } from "../../state/environments";
import { ForkChangelogSection } from "../forkChangelog/ForkChangelog";
import { FleetMachines } from "../machines/FleetMachines";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useMachineMapState } from "../../state/machineMap";
import { KitshnBadge } from "../machines/KitshnMark";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { ForkSettingsSlot } from "./ForkSettingsSlot";
import { kitshnJoinedText, type MachineMapClientState } from "@t3tools/contracts";

import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

/** The dropped items that the notice names; the rest is a count. */
const PROBLEMS_SHOWN = 5;

export type FleetTab = "machines" | "changelog";

/**
 * Fork: the Fleet view at Settings > Fleet. One row per machine, then the kitshn state of the
 * selected environment. The Changelog tab shows while the fork changelog setting is on.
 */
export function FleetSettingsPanel({
  tab,
  onTabChange,
}: {
  readonly tab: FleetTab;
  readonly onTabChange: (tab: FleetTab) => void;
}) {
  const changelogEnabled = useClientSettings((settings) => settings.forkChangelogEnabled);
  const shownTab = changelogEnabled ? tab : "machines";
  return (
    <SettingsPageContainer>
      {changelogEnabled ? (
        <ToggleGroup
          aria-label="Fleet view"
          value={[shownTab]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "machines" || value === "changelog") onTabChange(value);
          }}
        >
          <Toggle value="machines">Machines</Toggle>
          <Toggle value="changelog">Changelog</Toggle>
        </ToggleGroup>
      ) : null}
      {shownTab === "changelog" ? (
        <ForkChangelogSection />
      ) : (
        <>
          <SettingsSection title="Fleet">
            <FleetMachines />
          </SettingsSection>
          <MachineKitshnSections />
        </>
      )}
    </SettingsPageContainer>
  );
}

/** The kitshn state and settings of the environment selected in Settings. */
function MachineKitshnSections() {
  const { environment } = useSettingsScope();
  const { state } = useMachineMapState(environment?.environmentId ?? null);
  const kitshnMachines = useKitshnMachines();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (environment === null) return null;
  const kitshnMachine = kitshnMachines.get(environment.environmentId);
  const problems = state?.connection.problems ?? [];
  return (
    <>
      {problems.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>kitshn dropped part of this machine's cards</AlertTitle>
          <AlertDescription>
            {problems.slice(0, PROBLEMS_SHOWN).map((problem) => (
              <span className="block" key={problem.path}>
                {problem.path}: {problem.reason}
              </span>
            ))}
            {problems.length > PROBLEMS_SHOWN ? (
              <span className="block">and {problems.length - PROBLEMS_SHOWN} more</span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <SettingsSection title="kitshn">
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              {environment.label}
              <KitshnBadge machine={kitshnMachine} />
            </span>
          }
          description={
            kitshnMachine !== undefined
              ? kitshnJoinedText(kitshnMachine)
              : environment.environmentId === primaryEnvironmentId
                ? "This machine is not joined to kitshn."
                : "A manual environment: an address that you added and paired."
          }
        />
        {state === null ? null : <ConnectionRow connection={state.connection} />}
        {isElectron ? <DeviceInviteSettingsRow /> : null}
        <ForkSettingsSlot place="machines-machine-map" />
      </SettingsSection>
    </>
  );
}

const STATUS_TITLE = {
  off: "Not with kitshn",
  connecting: "Connecting to kitshn",
  registered: "Connected to kitshn",
} as const;

/** A reconnect note shows for this long after T3 ended a stuck connection. */
const RESTART_NOTE_MS = 60 * 60 * 1000;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const relativeTime = (epochMs: number) => formatRelativeTimeLabel(new Date(epochMs).toISOString());

/** The line about the status: why it is off, or why it reconnected. */
function statusNote(connection: MachineMapClientState["connection"], nowMs: number): string | null {
  if (connection.detail === null) return null;
  if (connection.status !== "registered") return sentence(connection.detail);
  const { restartedAt } = connection;
  if (restartedAt === null || nowMs - restartedAt > RESTART_NOTE_MS) return null;
  return `Reconnected ${relativeTime(restartedAt)}: ${connection.detail}`;
}

/** K-1611: the provider connection of this server and what kitshn gave it. */
function ConnectionRow({ connection }: { connection: MachineMapClientState["connection"] }) {
  // A minute tick keeps the relative times current and ends the reconnect note on time.
  const nowMs = Date.parse(`${useNowMinute()}Z`);
  // While off, this server does not talk to kitshn, so the contact facts say nothing.
  const facts =
    connection.status === "off"
      ? []
      : [
          `${connection.reachedMachines} reached machines`,
          connection.linkProxy ? "link proxy ready" : "no link proxy",
          connection.syncedAt === null
            ? "no answer from kitshn yet"
            : `last sync with kitshn ${relativeTime(connection.syncedAt)}`,
        ];
  const factsLine = facts.length > 0 ? sentence(facts.join(" · ")) : null;
  const title = connection.paused
    ? "kitshn's emergency pause is on"
    : STATUS_TITLE[connection.status];
  const description = [statusNote(connection, nowMs), factsLine].filter(Boolean).join(". ");
  return (
    <SettingsRow
      title={title}
      description={description}
      copyActions={[
        { label: "Copy status", value: [title, description].filter(Boolean).join(". ") },
      ]}
    />
  );
}
