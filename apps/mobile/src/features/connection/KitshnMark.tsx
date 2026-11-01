/**
 * Fork: the mark of an environment that kitshn joined. A manual environment, an address that the
 * user typed and paired, has no mark.
 */
import { type KitshnMachineRef, kitshnJoinedText } from "@t3tools/contracts";

import { StatusPill } from "../../components/StatusPill";
import { AppText as Text } from "../../components/ui/AppText";

export function KitshnPill({ machine }: { readonly machine: KitshnMachineRef | null | undefined }) {
  return machine ? (
    <StatusPill
      label="kitshn"
      size="compact"
      pillClassName="bg-subtle"
      textClassName="text-foreground-muted"
    />
  ) : null;
}

export function KitshnJoinedLine({
  machine,
}: {
  readonly machine: KitshnMachineRef | null | undefined;
}) {
  return machine ? (
    <Text className="text-xs text-foreground-muted" numberOfLines={1}>
      {kitshnJoinedText(machine)}
    </Text>
  ) : null;
}
