/**
 * Fork: the mark of an environment that kitshn joined. A manual environment, an address that the
 * user typed and paired, has no mark.
 */
import { type KitshnMachineRef, kitshnJoinedText } from "@t3tools/contracts";

import { Badge } from "../ui/badge";

export function KitshnBadge({
  machine,
}: {
  readonly machine: Pick<KitshnMachineRef, "name"> | undefined;
}) {
  return machine === undefined ? null : (
    <Badge variant="info" size="sm" title={kitshnJoinedText(machine)}>
      kitshn
    </Badge>
  );
}

export function KitshnJoinedLine({
  machine,
}: {
  readonly machine: Pick<KitshnMachineRef, "name"> | undefined;
}) {
  return machine === undefined ? null : (
    <p className="truncate text-xs text-muted-foreground">{kitshnJoinedText(machine)}</p>
  );
}
