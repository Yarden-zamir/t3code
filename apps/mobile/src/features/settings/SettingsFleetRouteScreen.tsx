/**
 * Fork: the Fleet view on mobile, the read-only part of web Settings > Machines. One row per
 * machine; a row opens the environment settings, where the mobile actions are.
 */
import { useAtomValue } from "@effect/atom-react";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { fleetTaskSummary } from "@t3tools/client-runtime/fork/fleet";
import { kitshnJoinedText, type ScheduledTask } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ListRow } from "../../components/ui/ListRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { serverEnvironment } from "../../state/server";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

type ConnectedEnvironment = ReturnType<
  typeof useRemoteConnections
>["connectedEnvironments"][number];

export function SettingsFleetRouteScreen() {
  const insets = useSafeAreaInsets();
  const { connectedEnvironments } = useRemoteConnections();

  return (
    <SettingsScreen title="Fleet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {connectedEnvironments.length === 0 ? (
          <Text className="px-2 text-base text-foreground-muted">
            Add an environment or join this phone to kitshn with a device invite.
          </Text>
        ) : (
          <SettingsSection title="Machines">
            {connectedEnvironments.map((environment) => (
              <FleetRow key={environment.environmentId} environment={environment} />
            ))}
          </SettingsSection>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function FleetRow({ environment }: { readonly environment: ConnectedEnvironment }) {
  const navigation = useNavigation();
  const config = useAtomValue(serverEnvironment.configValueAtom(environment.environmentId));
  const connected = environment.connectionState === "connected" && config !== null;
  const tasks = useAtomValue(
    serverEnvironment.scheduledTasksLive({
      environmentId: environment.environmentId,
      input: {},
    }),
  );
  const kitshnMachine = config?.kitshnMachine;
  const detail = [
    connectionStatusText({
      phase: environment.connectionState,
      error: environment.connectionError,
      traceId: null,
    }),
    config === null ? null : `T3 ${config.environment.serverVersion}`,
    config === null ? null : `Auto-update ${config.settings.forkAutoUpdate ? "on" : "off"}`,
    connected ? scheduledTasksText(AsyncResult.getOrElse(tasks, () => null)?.tasks ?? null) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ListRow
      icon="desktopcomputer"
      label={
        kitshnMachine ? `${environment.environmentLabel} · kitshn` : environment.environmentLabel
      }
      description={
        kitshnMachine ? kitshnJoinedText(kitshnMachine) : "Manual environment: an address you added"
      }
      detail={detail}
      onPress={() =>
        navigation.navigate("SettingsEnvironmentDetail", {
          environmentId: environment.environmentId,
        })
      }
    />
  );
}

/** "3 scheduled tasks · last failed: Backup", or null before the list loads. */
function scheduledTasksText(tasks: ReadonlyArray<ScheduledTask> | null): string | null {
  if (tasks === null) return null;
  const { enabled, lastFailed } = fleetTaskSummary(tasks);
  return [
    `${enabled} scheduled ${enabled === 1 ? "task" : "tasks"}`,
    lastFailed === null ? null : `last failed: ${lastFailed.title}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
