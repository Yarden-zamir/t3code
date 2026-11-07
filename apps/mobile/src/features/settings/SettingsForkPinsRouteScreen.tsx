import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type MessagePin,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  messagePinKey,
  messagePinsNewestFirst,
  unpinMessagePatch,
} from "@t3tools/shared/messagePins";
import { Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { relativeTime } from "../../lib/time";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

interface EnvironmentMessagePin {
  readonly environmentId: EnvironmentId;
  readonly pin: MessagePin;
}

/**
 * Fork: the pins of every connected environment with `mobileMessagePins` on, newest first. The
 * web sidebar lists the same pins.
 */
export function forkMobileMessagePins(
  configs: ReadonlyMap<EnvironmentId, ServerConfig>,
): ReadonlyArray<EnvironmentMessagePin> {
  const pins: EnvironmentMessagePin[] = [];
  for (const [environmentId, config] of configs) {
    if (!config.settings.mobileMessagePins) continue;
    for (const pin of messagePinsNewestFirst(config.settings.pinnedMessages)) {
      pins.push({ environmentId, pin });
    }
  }
  // Hermes lacks toSorted; `pins` is a new array.
  return pins.sort((left, right) => right.pin.pinnedAt.localeCompare(left.pin.pinnedAt));
}

/** Fork: Settings > Fork > Pinned messages. A tap opens the thread at the message. */
export function SettingsForkPinsRouteScreen() {
  const insets = useSafeAreaInsets();
  const pins = forkMobileMessagePins(useServerConfigs());
  return (
    <SettingsScreen title="Pinned messages">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {pins.length === 0 ? (
          <Text className="px-2 text-base text-foreground-muted">
            No pinned messages. Hold the copy button of a message and pick Pin message.
          </Text>
        ) : (
          <SettingsSection>
            {pins.map((entry) => (
              <PinRow
                key={`${entry.environmentId}\u0000${messagePinKey(entry.pin.threadId, entry.pin.messageId)}`}
                {...entry}
              />
            ))}
          </SettingsSection>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function PinRow({ environmentId, pin }: EnvironmentMessagePin) {
  const selectDetail = useSelectWorkspaceDetail();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "message pin update");
  const shell = useAtomValue(
    environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, pin.threadId)),
  );
  const title = shell?.title.trim() || pin.threadTitle || pin.threadId;
  const missing = shell === null;
  const canWrite = readEnvironmentScope(environmentId, AuthSettingsWriteScope);
  return (
    <RowPressable
      accessibilityRole="link"
      accessibilityLabel={`Open pinned message: ${pin.excerpt}`}
      accessibilityState={{ disabled: missing }}
      disabled={missing}
      onPress={() =>
        selectDetail({
          name: "Thread",
          params: {
            environmentId: String(environmentId),
            threadId: String(pin.threadId),
            message: String(pin.messageId),
          },
        })
      }
      className="bg-grouped-card"
    >
      <ListRowLayout
        label={pin.excerpt || "Message"}
        description={[
          `${title} · ${relativeTime(pin.pinnedAt)}`,
          missing ? "Thread archived or deleted" : null,
        ]
          .filter((line) => line !== null)
          .join("\n")}
        accessory={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Unpin message"
            accessibilityState={{ disabled: !canWrite }}
            disabled={!canWrite}
            hitSlop={8}
            onPress={() =>
              void updateSettings({
                environmentId,
                input: { patch: { pinnedMessages: unpinMessagePatch(pin) } },
              })
            }
            className="size-9 items-center justify-center rounded-full active:opacity-60"
          >
            <SymbolView
              name="pin.slash"
              size={18}
              tintColorClassName="accent-icon"
              type="monochrome"
            />
          </Pressable>
        }
      />
    </RowPressable>
  );
}
