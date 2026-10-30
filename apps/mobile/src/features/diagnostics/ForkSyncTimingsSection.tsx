import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { formatSyncRun, syncTimings } from "@t3tools/client-runtime/fork/syncTimings";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { environmentCatalog } from "../../connection/catalog";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { SettingsSection } from "../settings/components/SettingsSection";

const COPIED_RESET_MS = 3000;

/** The timings are read when the screen opens or on Refresh, never while they change. */
export function ForkSyncTimingsSection() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const [snapshot, setSnapshot] = useState(() => syncTimings.snapshot());
  const [copied, setCopied] = useState(false);
  const label = (environmentId: EnvironmentId) =>
    catalog.entries.get(environmentId)?.target.label ?? "Removed environment";
  const runs = [snapshot.coldStart, ...snapshot.wakeups].map((run) => ({
    key: `${run.trigger}:${run.startedAtEpochMs}`,
    text: formatSyncRun(run, label),
  }));

  const copy = async () => {
    const ok = await tryCopyTextWithHaptic(
      ["T3 Code sync timings", ...runs.map((run) => run.text)].join("\n\n"),
      {
        target: "sync timings",
      },
    );
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  return (
    <View className="gap-3">
      <SettingsSection title="Sync timings">
        {runs.map(({ key, text }, index) => (
          <Text
            key={key}
            selectable
            className={
              index === 0
                ? "p-4 font-mono text-xs leading-snug text-foreground"
                : "border-t border-border-subtle p-4 font-mono text-xs leading-snug text-foreground"
            }
          >
            {text}
          </Text>
        ))}
      </SettingsSection>
      <SettingsSection title="Sync timing actions">
        <SettingsActionRow
          icon="arrow.clockwise"
          label="Refresh"
          onPress={() => {
            setSnapshot(syncTimings.snapshot());
            setCopied(false);
          }}
        />
        <SettingsActionRow
          icon={copied ? "checkmark" : "doc.on.doc"}
          label={copied ? "Copied" : "Copy sync timings"}
          onPress={() => void copy()}
        />
      </SettingsSection>
      <Text className="px-2 text-sm leading-normal text-foreground-muted">
        The app keeps the last cold start and the last 10 returns to the foreground in memory. Each
        line shows milliseconds from the start of the run. A span line also shows its duration.
        Environments show by name, never by address.
      </Text>
    </View>
  );
}
