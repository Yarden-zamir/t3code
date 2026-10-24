import { useNavigation } from "@react-navigation/native";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects } from "../../state/entities";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useUpdateVoicePreferences, useVoicePreferences } from "../../state/voice-preferences";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";

/**
 * Fork: the project of threads that the Android assistant panel starts. A screen of its own,
 * because one row per project of every server makes the Voice screen slow to open.
 */
export function SettingsVoiceProjectRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const voice = useVoicePreferences();
  const updateVoice = useUpdateVoicePreferences();
  const projects = useProjects();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const showsEnvironment = new Set(projects.map((project) => project.environmentId)).size > 1;
  const environmentLabel = (environmentId: string) =>
    connectedEnvironments.find((environment) => environment.environmentId === environmentId)
      ?.environmentLabel ?? "Disconnected";

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Project" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Threads from the assistant panel">
          <SettingsChoiceRow
            label="Last new thread project"
            description="The project of the last thread that you started on this phone."
            selected={voice.assistantProject === null}
            onPress={() => updateVoice({ assistantProject: undefined })}
          />
          {projects.map((project) => (
            <SettingsChoiceRow
              key={`${project.environmentId}:${project.id}`}
              label={project.title}
              {...(showsEnvironment
                ? { description: environmentLabel(project.environmentId) }
                : {})}
              selected={
                voice.assistantProject?.environmentId === project.environmentId &&
                voice.assistantProject.projectId === project.id
              }
              separated
              onPress={() =>
                updateVoice({
                  assistantProject: { environmentId: project.environmentId, projectId: project.id },
                })
              }
            />
          ))}
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
