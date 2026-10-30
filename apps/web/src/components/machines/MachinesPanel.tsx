import { ARROW_LINKS_EMPTY, kitshnMapUrl } from "@t3tools/client-runtime/fork/arrowLinks";
import type { EnvironmentId } from "@t3tools/contracts";
import { ExternalLinkIcon, NetworkIcon } from "lucide-react";

import { linkedMachines, useMachineMapState } from "~/state/machineMap";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

/** Fork: the machines that this environment's kitshn links reach (K-1609), read only. */
export function MachinesPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const { state } = useMachineMapState(environmentId);
  const query = useEnvironmentQuery(linkedMachines({ environmentId, input: {} }));
  // The first entry is this environment itself.
  const machines = query.data?.slice(1) ?? null;
  const mapUrl = kitshnMapUrl(window.location.origin);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        {state !== null && !state.joined ? (
          <CenteredMessage
            title="Not on kitshn"
            detail="Join this machine with kitshn join <code> --server <address> on the machine."
          />
        ) : machines === null ? (
          <CenteredMessage
            title={
              query.error === null ? "Loading the linked machines" : "Could not read the links"
            }
            detail={query.error ?? ""}
          />
        ) : machines.length === 0 ? (
          <CenteredMessage title="No linked machines" detail={ARROW_LINKS_EMPTY} />
        ) : (
          <div className="flex flex-col gap-1 p-2">
            {machines.map((machine) => (
              <div
                key={machine.environmentId}
                className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-sm"
              >
                <NetworkIcon className="size-3.5 text-muted-foreground" />
                {machine.name}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
      {mapUrl === null ? null : (
        <footer className="flex justify-end border-t border-border/60 px-2 py-1.5">
          <Button
            size="xs"
            variant="ghost"
            render={<a href={mapUrl} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon className="size-3" />
            Open the kitshn map
          </Button>
        </footer>
      )}
    </div>
  );
}

function CenteredMessage({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {detail === "" ? null : <p className="text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}
