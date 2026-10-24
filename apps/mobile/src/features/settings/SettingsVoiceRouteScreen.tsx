import { useNavigation } from "@react-navigation/native";
import { ProjectId } from "@t3tools/contracts";
import { PermissionsAndroid, Platform, View, type Permission } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { assistantNative } from "../../native/assistant";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  READ_ALOUD_RATES,
  type AssistantInputMode,
  type AssistantTarget,
  type ReadAloudRate,
} from "../../persistence/forkVoicePreferences";
import { useProject } from "../../state/entities";
import { useUpdateVoicePreferences, useVoicePreferences } from "../../state/voice-preferences";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const TARGET_OPTIONS: ReadonlyArray<{
  readonly target: AssistantTarget;
  readonly label: string;
  readonly description: string;
}> = [
  { target: "newThread", label: "A new thread", description: "In the project set below." },
  {
    target: "lastThread",
    label: "The last thread you opened",
    description: "Tap the title in the panel to pick another thread or project.",
  },
];

const INPUT_OPTIONS: ReadonlyArray<{
  readonly mode: AssistantInputMode;
  readonly label: string;
  readonly description: string;
}> = [
  { mode: "text", label: "Keyboard", description: "The panel opens with the keyboard up." },
  { mode: "voice", label: "Voice", description: "The panel opens the speech dialog right away." },
];

// Android 13 split photo access out of storage access.
const PHOTO_PERMISSION =
  Platform.OS === "android" && Platform.Version >= 33
    ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES
    : PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE;

const RATE_LABELS: Record<ReadAloudRate, string> = {
  0.75: "Slow",
  1: "Normal",
  1.25: "Fast",
  1.5: "Faster",
  2: "Fastest",
};

/** Fork: the Android assistant panel and read aloud. Every value is local to this phone. */
export function SettingsVoiceRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const voice = useVoicePreferences();
  const updateVoice = useUpdateVoicePreferences();
  // Turning a pill on asks for its access first; a refusal keeps it off.
  const setWithPermission = async (
    key: "assistantRecentPhoto" | "assistantLocation",
    value: boolean,
    permission: Permission,
    access: string,
  ) => {
    if (!value) return updateVoice({ [key]: false });
    const result = await PermissionsAndroid.request(permission);
    if (result === PermissionsAndroid.RESULTS.GRANTED) return updateVoice({ [key]: true });
    Dialog.alert(
      `No ${access} access`,
      `Allow ${access} access for T3 Code in Android settings to use this pill.`,
    );
  };
  const chosenProject = useProject(
    voice.assistantProject
      ? {
          environmentId: voice.assistantProject.environmentId,
          projectId: ProjectId.make(voice.assistantProject.projectId),
        }
      : null,
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Voice" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {assistantNative ? (
          <>
            <SettingsSection title="Android assistant">
              <SettingsActionRow
                icon="gearshape"
                label="Choose the digital assistant"
                description="Pick T3 Code, and turn on screen text and screenshots there."
                onPress={() => assistantNative?.openAssistantSettings()}
              />
            </SettingsSection>
            <SettingsSection title="The panel sends to">
              {TARGET_OPTIONS.map((option, index) => (
                <SettingsChoiceRow
                  key={option.target}
                  label={option.label}
                  description={option.description}
                  selected={voice.assistantTarget === option.target}
                  separated={index > 0}
                  onPress={() => updateVoice({ assistantTarget: option.target })}
                />
              ))}
            </SettingsSection>
            <SettingsSection title="The panel opens with">
              {INPUT_OPTIONS.map((option, index) => (
                <SettingsChoiceRow
                  key={option.mode}
                  label={option.label}
                  description={option.description}
                  selected={voice.assistantInput === option.mode}
                  separated={index > 0}
                  onPress={() => updateVoice({ assistantInput: option.mode })}
                />
              ))}
            </SettingsSection>
            <SettingsSection title="Panel">
              <SettingsSwitchRow
                label="Start the thread after speaking"
                subtitle="Skips the Start thread tap when the speech dialog returns text."
                value={voice.assistantSendAfterVoice}
                onValueChange={(value) => updateVoice({ assistantSendAfterVoice: value })}
              />
              <SettingsSwitchRow
                label="Attach the screenshot"
                value={voice.assistantAttachScreenshot}
                onValueChange={(value) => updateVoice({ assistantAttachScreenshot: value })}
              />
              <SettingsSwitchRow
                label="Attach the screen text"
                value={voice.assistantAttachScreenText}
                onValueChange={(value) => updateVoice({ assistantAttachScreenText: value })}
              />
              <SettingsSwitchRow
                label="Open the thread"
                subtitle="Opens the new thread in the app after the server takes it."
                value={voice.assistantOpenThread}
                onValueChange={(value) => updateVoice({ assistantOpenThread: value })}
              />
              <SettingsSwitchRow
                label="Read the first reply aloud"
                subtitle="The panel stays open until the agent replies and reads the reply."
                value={voice.assistantSpeakFirstReply}
                onValueChange={(value) => updateVoice({ assistantSpeakFirstReply: value })}
              />
            </SettingsSection>
            <SettingsSection
              title="Context pills"
              footer="These pills wait for a tap before they go along. Revoke the access in Android settings."
            >
              <SettingsSwitchRow
                label="Recent photo"
                subtitle="Offers the newest photo from the last 15 minutes. Asks for photo access."
                value={voice.assistantRecentPhoto}
                onValueChange={(value) =>
                  void setWithPermission("assistantRecentPhoto", value, PHOTO_PERMISSION, "photo")
                }
              />
              <SettingsSwitchRow
                label="Location"
                subtitle="Offers the place the phone last knew. Asks for approximate location."
                value={voice.assistantLocation}
                onValueChange={(value) =>
                  void setWithPermission(
                    "assistantLocation",
                    value,
                    PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
                    "location",
                  )
                }
              />
            </SettingsSection>
            <SettingsSection title="New threads">
              <SettingsRow
                icon="folder"
                label="Project"
                value={chosenProject?.title ?? "Last new thread project"}
                target="SettingsVoiceProject"
              />
            </SettingsSection>
          </>
        ) : null}

        <SettingsSection title="Read aloud">
          <SettingsSwitchRow
            label="Read-aloud button on replies"
            subtitle="Tap it to hear a reply. Hold it to hear every new reply of that thread."
            value={voice.readAloudButton}
            onValueChange={(value) => updateVoice({ readAloudButton: value })}
          />
          {voice.readAloudThreads.length > 0 ? (
            <SettingsActionRow
              label="Stop reading threads aloud"
              description={`${voice.readAloudThreads.length} ${voice.readAloudThreads.length === 1 ? "thread reads" : "threads read"} new replies aloud.`}
              onPress={() => updateVoice({ readAloudThreads: [] })}
            />
          ) : null}
        </SettingsSection>
        <SettingsSection title="Speech rate">
          {READ_ALOUD_RATES.map((rate, index) => (
            <SettingsChoiceRow
              key={rate}
              label={RATE_LABELS[rate]}
              description={`${rate}×`}
              selected={voice.readAloudRate === rate}
              separated={index > 0}
              onPress={() => updateVoice({ readAloudRate: rate })}
            />
          ))}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          Replies are read only while the app or the assistant panel is on screen.
        </Text>
      </ScrollView>
    </View>
  );
}
