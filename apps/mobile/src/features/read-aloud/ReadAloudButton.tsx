import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  ToastAndroid,
  type ColorValue,
} from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { useUpdateVoicePreferences, useVoicePreferences } from "../../state/voice-preferences";
import { readAloud, readingAloudIdAtom, stopReadingAloud } from "./readAloud";

function announce(message: string) {
  if (Platform.OS === "android") ToastAndroid.show(message, ToastAndroid.SHORT);
  else AccessibilityInfo.announceForAccessibility(message);
}

/**
 * Fork: reads one reply aloud. Holding it reads every new reply of the thread aloud, until it is
 * held again. The filled, tinted icon shows that the thread reads new replies.
 */
export function ReadAloudButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly text: string;
  readonly tintColor: ColorValue;
}) {
  const voice = useVoicePreferences();
  const updateVoice = useUpdateVoicePreferences();
  const readingId = useAtomValue(readingAloudIdAtom);
  if (!voice.readAloudButton) return null;

  const reading = readingId === props.messageId;
  const threadReads = voice.readAloudThreads.some(
    (ref) => ref.environmentId === props.environmentId && ref.threadId === props.threadId,
  );
  const toggleThread = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    updateVoice({
      readAloudThreads: threadReads
        ? voice.readAloudThreads.filter(
            (ref) => ref.environmentId !== props.environmentId || ref.threadId !== props.threadId,
          )
        : [
            ...voice.readAloudThreads,
            { environmentId: props.environmentId, threadId: props.threadId },
          ],
    });
    announce(threadReads ? "New replies are no longer read aloud" : "New replies are read aloud");
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={reading ? "Stop reading aloud" : "Read aloud"}
      accessibilityHint={
        threadReads
          ? "Hold to stop reading new replies of this thread"
          : "Hold to read every new reply of this thread"
      }
      accessibilityState={{ selected: threadReads }}
      disabled={props.text.length === 0}
      hitSlop={8}
      onPress={() =>
        reading
          ? stopReadingAloud()
          : readAloud({ id: props.messageId, markdown: props.text, rate: voice.readAloudRate })
      }
      onLongPress={toggleThread}
      className="h-7 w-7 items-center justify-center rounded-[9px]"
      style={({ pressed }) => ({ opacity: pressed ? 0.52 : 1 })}
    >
      <SymbolView
        name={reading ? "stop.fill" : threadReads ? "speaker.wave.2.fill" : "speaker.wave.2"}
        size={13}
        tintColor={threadReads ? undefined : props.tintColor}
        tintColorClassName={threadReads ? "accent-primary" : undefined}
        type="monochrome"
      />
    </Pressable>
  );
}
